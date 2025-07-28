import argparse
import json
import sys
import copy
import os
import asyncio
import time
import random
from google.api_core import exceptions as api_exceptions

# The MCP tap uses a prefix to tool descriptions in order to manipulate the LLMs to choose 
# the tapped version of available tool calls. 
# This script allows to test the LLM's given different models, prompts and tools. It validates
# that the chosen prefix will succeed over a given success rate.

# Suppress TensorFlow warnings
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'

import vertexai
from vertexai.generative_models import GenerativeModel, Tool, FunctionDeclaration
# --- NEW IMPORT for Claude models ---
from anthropic import AnthropicVertex, RateLimitError


MODEL_PRICING = {
    # Keys are prefixes
    "gemini-2.5-pro": {"input": 3.00, "output": 9.00},
    "gemini-2.0-flash": {"input": 0.10, "output": 0.30},
    "claude-opus-4": {"input": 12.00, "output": 60.00},
    "claude-3-7-sonnet": {"input": 2.50, "output": 12.50},
    "llama3-8b": {"input": 0.50, "output": 0.50},
    "llama3-70b": {"input": 2.65, "output": 2.65},
    "default": {"input": 0.13, "output": 0.38, "is_fallback": True}
}

MIRRORED_SUFFIX = "_mirrored"

# --- ARGUMENT PARSING & RESOURCE LOADING (No changes) ---
def parse_arguments():
    """Parses command-line arguments."""
    parser = argparse.ArgumentParser(description="Test LLM preference for mirrored tool calls.")
    parser.add_argument("--project-id", required=True, help="Your Google Cloud project ID.")
    parser.add_argument("--location", default="us-central1", help="Your Google Cloud project location.")
    parser.add_argument("--models", required=True, nargs='+', help="A space-separated list of model names to test.")
    parser.add_argument("--repetitions", type=int, default=100, help="Number of times to run each prompt.")
    parser.add_argument("--rate", type=float, default=95.0, help="Required success rate for a prompt to pass.")
    parser.add_argument("--prefix-file", default="prefix.txt", help="File containing the description prefix.")
    parser.add_argument("--tools-file", default="tools.json", help="JSON file with tool schemas.")
    parser.add_argument("--prompts-file", default="prompts.txt", help="File with prompts, separated by '---'.")
    parser.add_argument("--parallelism", type=int, default=16, help="Number of concurrent API calls to send.")
    return parser.parse_args()

def load_resources(prefix_file, tools_file, prompts_file):
    """Loads and validates resources from files."""
    try:
        with open(prefix_file, 'r') as f:
            prefix = f.read().strip()
        with open(tools_file, 'r') as f:
            original_tools = json.load(f)
        if not isinstance(original_tools, list) or len(original_tools) < 1:
            print("❌ Error: tools.json must contain a JSON list with at least one tool.")
            sys.exit(1)
        with open(prompts_file, 'r') as f:
            prompts = [p.strip() for p in f.read().split('---') if p.strip()]
    except FileNotFoundError as e:
        print(f"❌ Error: Could not find required file: {e.filename}")
        sys.exit(1)
    print(f"✅ Loaded {len(original_tools)} tools and {len(prompts)} prompts.")
    return prefix, original_tools, prompts

def create_mirrored_tools(original_tools, prefix):
    """Creates mirrored versions of tools with the specified prefix."""
    mirrored_tools = []
    for tool_schema in original_tools:
        mirrored_tool = copy.deepcopy(tool_schema)
        mirrored_tool["name"] = f"{tool_schema['name']}{MIRRORED_SUFFIX}"
        mirrored_tool["description"] = f"{prefix} {tool_schema['description']}"
        mirrored_tools.append(mirrored_tool)
    return mirrored_tools
# --- END of unchanged section ---


async def call_standard_model(model, prompt, tools, pricing_info, prompt_index):
    """Handles API calls for standard (Gemini, etc.) models."""
    response = await model.generate_content_async(
        prompt,
        tools=tools,
        generation_config={"temperature": 0.0}
    )
    
    usage = response.usage_metadata
    cost = (usage.prompt_token_count / 1_000_000) * pricing_info["input"] + \
           (usage.candidates_token_count / 1_000_000) * pricing_info["output"]
    
    function_call = None
    try:
        function_call = response.candidates[0].content.parts[0].function_call
    except (AttributeError, IndexError):
        pass

    return function_call, cost, str(response)

async def call_claude_model(client, model_name, prompt, tools_json, pricing_info, prompt_index):
    """Handles API calls for Claude models using the AnthropicVertex SDK."""
    response = await client.messages.create(
        model=model_name,
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
        tools=tools_json
    )
    
    cost = (response.usage.input_tokens / 1_000_000) * pricing_info["input"] + \
           (response.usage.output_tokens / 1_000_000) * pricing_info["output"]
    
    function_call = None
    try:
        # Find the tool_use content block in the response
        for content_block in response.content:
            if content_block.type == "tool_use":
                function_call = content_block
                break
    except (AttributeError, IndexError):
        pass
    
    return function_call, cost, str(response)


async def run_single_repetition(semaphore, client_or_model, is_claude_model, model_name, prompt, tools_sdk, tools_json, pricing_info, prompt_index):
    """Dispatcher: runs a single API call with retries and failure logging."""
    async with semaphore:
        retries = 3
        while retries > 0:
            is_mirrored = False
            failure_log = None
            cost = 0.0

            try:
                if is_claude_model:
                    function_call, cost, raw_response = await call_claude_model(client_or_model, model_name, prompt, tools_json, pricing_info, prompt_index)
                else:
                    function_call, cost, raw_response = await call_standard_model(client_or_model, prompt, tools_sdk, pricing_info, prompt_index)

                if function_call:
                    if function_call.name.endswith(MIRRORED_SUFFIX):
                        is_mirrored = True
                    else:
                        failure_log = {"prompt": prompt, "response": raw_response}
                # No function_call is treated as a non-mirrored call (failure) but not an error
                
                return (prompt_index, is_mirrored, cost, failure_log)

            except (api_exceptions.TooManyRequests, RateLimitError) as e:
                retries -= 1
                if retries > 0:
                    wait_time = random.uniform(5, 10)
                    print(f"🚦 429 Quota Error on prompt {prompt_index + 1}. Retrying in {wait_time:.2f}s... ({retries} retries left)", file=sys.stderr)
                    await asyncio.sleep(wait_time)
                else:
                    failure_log = {"prompt": prompt, "error": f"Failed after multiple retries: {e}"}
                    return (prompt_index, False, cost, failure_log)
            
            except Exception as e:
                failure_log = {"prompt": prompt, "error": f"Non-retryable error: {e}"}
                return (prompt_index, False, cost, failure_log)

def print_prompt_results(prompt_index, prompt, stats, rate):
    """Prints the formatted results for a completed prompt."""
    successes = stats["successes"]
    failures = stats["failures"]
    total_runs = successes + failures
    
    print(f"\n--- Prompt {prompt_index + 1} FINISHED ---")
    print(f"> {prompt}")
    
    if total_runs > 0:
        success_percentage = (successes / total_runs) * 100
        result_status = "✅ PASSED" if success_percentage >= rate else "❌ FAILED"
        print(f"Result: {successes}/{total_runs} ({success_percentage:.2f}%) mirrored calls. Status: {result_status}")
    else:
        print("Result: 0/0 (No successful runs to analyze)")

async def main():
    """Main asynchronous function to run the test suite."""
    args = parse_arguments()
    prefix, original_tools_json, prompts = load_resources(args.prefix_file, args.tools_file, args.prompts_file)
    max_parallel_calls = min(args.parallelism, args.repetitions * len(prompts))

    mirrored_tools_json = create_mirrored_tools(original_tools_json, prefix)
    all_tools_json = original_tools_json + mirrored_tools_json
    all_declarations = [FunctionDeclaration(**d) for d in all_tools_json]
    all_tools_sdk = [Tool(function_declarations=all_declarations)]

    print("\n--- Initializing Vertex AI ---")
    try:
        vertexai.init(project=args.project_id, location=args.location)
        print(f"✅ Vertex AI initialized for project '{args.project_id}' in '{args.location}'.")
    except Exception as e:
        print(f"❌ Failed to initialize Vertex AI: {e}", file=sys.stderr)
        sys.exit(1)
    
    print("\n--- Starting Test Run ---")

    for model_name in args.models:
        print(f"\n==================== Testing Model: {model_name} ====================")
        
        pricing_info = MODEL_PRICING["default"]
        sorted_prefixes = sorted([k for k in MODEL_PRICING if k != "default"], key=len, reverse=True)
        for prefix in sorted_prefixes:
            if model_name.startswith(prefix):
                pricing_info = MODEL_PRICING[prefix]
                break

        if pricing_info.get("is_fallback"):
            print(f"⚠️ Warning: Price for model '{model_name}' not found. Using default fallback pricing.")
        
        client_or_model = None
        is_claude_model = model_name.startswith("claude")
        try:
            if is_claude_model:
                print("INFO: Using AnthropicVertex client for Claude model.")
                client_or_model = AnthropicVertex(region=args.location, project_id=args.project_id)
            else:
                client_or_model = GenerativeModel(model_name)

        except Exception as e:
            print(f"❌ Could not load model/client for '{model_name}'. Skipping. Error: {e}", file=sys.stderr)
            continue
        
        start_time = time.time()
        semaphore = asyncio.Semaphore(max_parallel_calls)
        tasks = []

        for i, prompt in enumerate(prompts):
            for _ in range(args.repetitions):
                tasks.append(run_single_repetition(semaphore, client_or_model, is_claude_model, model_name, prompt, all_tools_sdk, all_tools_json, pricing_info, i))
        
        prompt_progress = {i: {"successes": 0, "failures": 0, "completed": 0, "reported": False} for i in range(len(prompts))}
        total_model_cost = 0.0
        failure_logs = []

        for future in asyncio.as_completed(tasks):
            prompt_index, is_mirrored, cost, failure_log = await future
            total_model_cost += cost

            if failure_log:
                failure_logs.append(failure_log)
            
            if is_mirrored:
                prompt_progress[prompt_index]["successes"] += 1
            else:
                prompt_progress[prompt_index]["failures"] += 1
            
            prompt_progress[prompt_index]["completed"] += 1

            stats = prompt_progress[prompt_index]
            if stats["completed"] == args.repetitions and not stats["reported"]:
                print_prompt_results(prompt_index, prompts[prompt_index], stats, args.rate)
                stats["reported"] = True
        
        end_time = time.time()
        total_model_successes = sum(p["successes"] for p in prompt_progress.values())
        total_model_repetitions = sum(p["completed"] for p in prompt_progress.values())
        
        print("\n--- Model Summary ---")
        if total_model_repetitions > 0:
            overall_percentage = (total_model_successes / total_model_repetitions) * 100
            print(f"Model '{model_name}' Overall Success: {total_model_successes}/{total_model_repetitions} ({overall_percentage:.2f}%)")
        else:
            print(f"Model '{model_name}' Overall Success: 0/0")
        
        print(f"💰 Estimated Cost for this Model: ${total_model_cost:.4f}")
        print(f"⏱️ Total Time Taken: {end_time - start_time:.2f} seconds")

        if failure_logs:
            print("\n--- ❌ Failure Log ---")
            for i, log in enumerate(failure_logs):
                print(f"\nFailure #{i+1}:")
                print(f"  Prompt: {log['prompt']}")
                if "response" in log:
                    print(f"  Response: {log['response']}")
                elif "error" in log:
                    print(f"  Error: {log['error']}")
        else:
            print("\n✅ No failures recorded for this model.")


if __name__ == "__main__":
    asyncio.run(main())