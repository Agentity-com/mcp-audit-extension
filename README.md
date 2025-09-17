# MCP Audit by Agentity

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/agentity.mcp-audit-extension.svg)](https://marketplace.visualstudio.com/items?itemName=agentity.mcp-audit-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Audit and log all GitHub Copilot MCP tool calls in VSCode with ease.**

## Table of Contents

- [Overview](#overview)
- [Key Use Cases](#key-use-cases)
- [Installation](#installation)
  - [From the Command Line](#from-the-command-line)
  - [From the Visual Studio Code UI](#from-the-visual-studio-code-ui)
- [Usage](#usage)
- [Configuration](#configuration)
- [Log Data Format](#log-data-format)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [License](#license)
- [Contact](#Contact)

## Overview

The MCP Audit extension for Visual Studio Code provides essential visibility into the MCP tools and commands executed by GitHub Copilot. As AI Copilots become more integrated into development workflows, the ability to audit their actions is critical for security, compliance, and operational insight.

This extension transparently intercepts and logs all MCP tool calls, forwarding them to your preferred SIEM, centralized logging platform, or a local file.

## Key Use Cases

*   **Security & Compliance Audits**: Create a comprehensive audit trail of all MCP tool calls performed by GitHub Copilot, ensuring compliance with audit requirements and identifying potential security risks.
*   **Centralized Logging**: Aggregate MCP tool usage data from all developers into a central location (e.g., Splunk, Syslog), allowing AI, security, and IT teams to analyze trends and manage AI usage effectively.
*   **Developer Troubleshooting**: Provide developers with detailed logs of Copilot's tool interactions for easier debugging and a better understanding of its behavior.

<!-- MCP Audit Demo Video -->
<p align="center">
  <video width="640" height="360" controls>
    <source src="https://storage.googleapis.com/mcp-audit-video/MCPAuditDemo-High.mp4" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</p>

## Installation

> **Note:** This extension requires Visual Studio Code version 1.101 or newer.

MCP Audit is built for enterprise environments and is fully manageable via MDM or other configuration management tools, using the CLI. The deployment process involves two steps: installing the extension and pushing a centralized configuration file. Deployment on individual machines using the Visual Studio Code UI is available as well.

### From the Command Line

Install the extension directly from the marketplace using the appropriate command for your operating system.

```shell
code --install-extension agentity.mcp-audit-extension
```

### From the Visual Studio Code UI

1.  Open Visual Studio Code.
2.  Navigate to the **Extensions** view (`Ctrl+Shift+X`).
3.  Search for "**MCP Audit by Agentity**".
4.  Click **Install**.


## Usage

Upon installation, the extension automatically identifies all configured MCP servers in your VS Code settings. For each original server, it creates a mirrored `(tapped)` version.

To enable auditing, you must use these `(tapped)` servers. GitHub Copilot will indicate that new servers are available via a blue refresh icon in the chat panel's agent mode selector. Simply start the tapped servers when prompted.                               

The extension also adds a new view to the Explorer sidebar called **MCP Audit Log**. This view displays the last tool calls that have been logged, providing a quick and convenient way to review recent activity. This feature depends on the default file logger being enabled.
View icon:
<p align="left">
  <img src="mcp-icon-view.png" alt="MCP Icon View" width="80"/>
</p>

Any changes made to the original MCP server configurations, including the addition of new ones, will be automatically reflected in their corresponding tapped versions.

> **Note:** Auditing is only active when at least one log forwarder (HEC, Syslog, or File) is enabled in the extension's settings and you are using a `(tapped)` MCP server.

## Configuration

Configure the extension by navigating to **File > Preferences > Settings** and searching for "MCP Audit", or by directly editing your `settings.json` file. By default, a local file logger will be set up to log to the extension's data folder.                  

### Log Forwarders

The extension is configured by defining a list of log forwarders in the `mcpAudit.forwarders` setting. Each forwarder is an object in an array, allowing you to send logs to multiple destinations simultaneously (e.g., to Splunk and a local file).

To add a forwarder, open your `settings.json` and add a new object to the `mcpAudit.forwarders` array.
<details><summary>Full reference for forwarders configuration</summary>

#### Common Properties

Each forwarder object in the array must include the following properties:

| Property  | Type      | Description                                                                          |
| :-------- | :-------- | :----------------------------------------------------------------------------------- |
| `name`    | `string`  | A unique, user-friendly name for this forwarder (e.g., "Splunk Prod").               |
| `enabled` | `boolean` | Enable or disable this specific forwarder.                                           |
| `type`    | `string`  | The type of forwarder. Must be `HEC`, `CEF`, or `FILE`. This determines other fields. |

#### Forwarder-Specific Properties

Based on the `type` you select, you must provide additional properties.

##### HEC Forwarder (`type: "HEC"`)

For sending logs to a Splunk HTTP Event Collector (HEC).

| Property         | Type     | Description                                                  |
| :--------------- | :------- | :----------------------------------------------------------- |
| `url`            | `string` | The full URL of the Splunk HEC endpoint.                     |
| `tokenSecretKey` | `string` | The key to look up the HEC token from the secret store.      |
| `sourcetype`     | `string` | (Optional) The sourcetype for the events.                    |
| `index`          | `string` | (Optional) The Splunk index to send data to.                 |

##### CEF/Syslog Forwarder (`type: "CEF"`)

For sending logs in Common Event Format (CEF) over Syslog.

| Property   | Type     | Description                                      |
| :--------- | :------- | :----------------------------------------------- |
| `host`     | `string` | The IP address or hostname of the Syslog server. |
| `port`     | `integer`| The port number of the Syslog server.            |
| `protocol` | `string` | The transport protocol. Can be `tcp`, `udp`, or `tls`. |

##### File Forwarder (`type: "FILE"`)

For writing logs to a local file.

| Property | Type     | Description                           |
| :------- | :------- | :------------------------------------ |
| `path`   | `string` | The full, absolute path to the log file. |
</details>
<details><summary>Example of a valid configuration</summary>

#### Configuration Example

Here is an example `settings.json` configuration with three different forwarders defined.

```json
{
  "mcpAudit.forwarders": [
    {
      "name": "Default File Logger",
      "enabled": true,
      "type": "FILE",
      "maxSize": "10M",
      "path": "C:\\Users\\john.smith\\AppData\\Roaming\\Code\\User\\globalStorage\\agentity.mcp-audit-extension\\mcp-tool-calls.log"
    },
    {
      "name": "Splunk Production",
      "enabled": true,
      "type": "HEC",
      "url": "https://splunk.mycompany.com:8088/services/collector",
      "tokenSecretKey": "prod-hec-token"
    },
    {
      "name": "Local Log Backup",
      "enabled": true,
      "type": "FILE",
      "path": "C:\\logs\\mcp-tap.log"
    },
    {
      "name": "Security SIEM (Disabled)",
      "enabled": false,
      "type": "CEF",
      "host": "siem.mycompany.com",
      "port": 514,
      "protocol": "tls"
    }
  ]
}
```
</details>
<details><summary>How to distribute secret tokens securely</summary>

#### Secure Token Configuration for HEC

To avoid storing sensitive tokens in settings files, the HEC forwarder uses a secure, one-time mechanism to load secrets. The configuration only points to a key, which the extension maps to a secret token value.

The process involves creating a temporary `mcp-tap-secrets.json` file in the user's VS Code configuration directory. On its first run, the extension reads the token from this file, moves it into VS Code's encrypted secret storage, and then deletes the temporary file from the disk.

**For MDM deployments**, your script should place this file on the user's machine *before* running the installation.

1.  **Create `mcp-tap-secrets.json`**: The file should be placed in the appropriate directory for the OS:
    *   **Windows:** `%APPDATA%\Code\User\mcp-tap-secrets.json`
    *   **macOS:** `~/Library/Application Support/Code/User/mcp-tap-secrets.json`
    *   **Linux:** `~/.config/Code/User/mcp-tap-secrets.json`

2.  **Add the Token**: The file should contain a JSON object where the key matches the `tokenSecretKey` value from your `settings.json` configuration. For example, if your `tokenSecretKey` is `"prod-hec-token"`, the JSON would be:
    ```json
    { "prod-hec-token": "YOUR-SECRET-HEC-TOKEN-VALUE" }
    ```
On the next launch, the extension will load the token to secret storage and delete the file.
</details>

### API Key

On audit.agentity.com, you can retrieve an API key for free. With a valid API key, the extension will log the contents of the results or errors of MCP tool calls, as well as the parameters of the requests. The API key is distributed similarly to the secret HEC keys described above. Use the key `API_KEY` within the secrets JSON file:
    ``` 
    { "API_KEY": "GENERATED_JWT" } 
    ```

## Log Data Format

All tool calls are logged as a JSON object with a consistent structure. This allows for easy parsing and integration with logging platforms and SIEMs.
<details><summary>Reference for full MCP tool call log format</summary>

| Field         | Type     | Description                                                                                |
| :------------ | :------- | :----------------------------------------------------------------------------------------- |
| `mcpServerName` | `string` | The name of the  MCP server that handled the call.                                   |
| `toolName`      | `string` | The name of the tool that was called (e.g., `terminal.runCommand`).                        |
| `agentId`       | `string` | A unique, anonymous identifier for the machine running the copilot.                                   |
| `hostName`      | `string` | The hostname of the machine where the extension is running.                                |
| `ipAddress`     | `string` | The local IP address of the machine.                                                       |
| `timestamp`     | `string` | The ISO 8601 timestamp indicating when the tool call occurred.                             |
| `params`        | `object` | The arguments that were provided to the tool.                                              |
| `_meta`         | `object` | Metadata returned by the MCP server.                        |
| `result`        | `any`    | The successful result returned by the tool. This field is omitted if an error occurred. *Only filled if valid API key is set.*    |
| `error`         | `any`    | The error message or object if the tool call failed. This field is omitted on success. *Only filled if valid API key is set.*     |
</details>
<details><summary>Example of MCP tool call record</summary>

### Example Log Record

Here is an example of a log record for a successful call to the `terminal.runCommand` tool.

```json
{
  "toolName": "terminal.runCommand",
  "mcpServerName": "Terminal",
  "agentId": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
  "hostName": "dev-machine-01",
  "ipAddress": "192.168.1.100",
  "timestamp": "2025-07-27T10:30:00.123Z",
  "params": {
    "command": "ls -la"
  },
  "_meta": {
    "correlationId": "copilot-xyz-789"
  },
  "result": {
    "stdout": "total 8\ndrwxr-xr-x 2 user group 4096 Jul 27 10:29 .\n-rw-r--r-- 1 user group 1024 Jul 27 10:28 file.txt",
    "stderr": "",
    "exitCode": 0
  }
}
```
</details>

## Limitations

*   **Forked IDEs**: Compatibility with forked versions of VS Code like Cursor and Windsurf depends on their adoption of VS Code base version 1.101+. Support is planned for future releases.
*   **Server Disabling**: This extension works by creating mirrored servers. If a developer intentionally disables a `(tapped)` server and uses the original, its calls will not be audited. The extension is designed to be transparent for standard workflows.
*   **Local Server Conflicts**: For local MCP servers, the tap spawns an additional process. This may cause conflicts if the server binds to exclusive resources, such as a specific local port.
*   **Tool Call Limit**: GitHub Copilot currently limits prompts to 128 tool calls. This means a maximum of 64 audited tool calls can be processed in a single interaction.
*   **Configuration Restart**: If you use secret input variables for your MCP configuration, a restart of VS Code may be required for the extension to mirror the configuration correctly.

## Troubleshooting

If you find that your MCP tool calls are not being logged, please follow these steps to diagnose the issue.

### Review Limitations
First, please review the [Limitations](#limitations) section to ensure the issue you're encountering is not related to a known constraint of the extension.

### Confirm You Are Using a `(tapped)` Server
The extension works by creating mirrored `(tapped)` versions of your MCP servers. Auditing is only active for these tapped servers. You can confirm which server is in use by looking at the server name visible in GitHub Copilot's tool call prompt. If you are not using a server with the `(tapped)` suffix, its calls will not be audited.

### Check Logs for Errors or Issues
The extension and tapped servers generate detailed logs that are essential for troubleshooting. Check these logs for any error messages, especially those related to forwarder configuration (e.g., invalid URL, incorrect token) or connectivity issues (e.g., network errors, firewall blocks).

You can view live logs in the VS Code **Output** panel:
1.  Open the Output panel (`Ctrl+Shift+U` or **View > Output**).
2.  From the dropdown menu in the top-right of the panel, select one of the following:
    *   **`MCP Audit Extension`**: For logs related to the extension's initialization, configuration, and forwarder status.
    *   **`MCP Server: <Server Name> (tapped)`**: For logs specific to a tapped MCP server, including details on individual tool calls.

For persistent log files on disk, check the following locations based on your operating system.
*   **Windows**: `%APPDATA%\Code\logs\<timestamp>\window<X>\exthost\Agentity.mcp-audit-extension\MCP Audit Extension.log`
*   **macOS**: `~/Library/Application Support/Code/logs/<timestamp>/window<X>\exthost/Agentity.mcp-audit-extension/MCP Audit Extension.log`
*   **Linux**: `~/.config/Code/logs/<timestamp>/exthost/window<X>\Agentity.mcp-audit-extension/MCP Audit Extension.log`

Replace `<timestamp>` with the relevant folder for your session (e.g., `20250729T103000`). There are multiple window folders that correlate to separate instantiations of VScode on that day. Look for errors indicating that forwarders could not be reached or were misconfigured.

### Get in Touch
If you have followed the steps above and are still unable to resolve the issue, please reach out for assistance. You can:

*   **Open an Issue on GitHub**: For the most efficient support, please [open an issue](https://github.com/agentborisdanilovich/mcp-audit-extension/issues) on our GitHub repository. Include any relevant, non-sensitive snippets from your logs.
*   **Email Support**: Alternatively, you can contact our support team at support@agentity.com.

## FAQ

*   **What data is sent to the Agentity cloud?**
    The Agentity cloud only collects a registration event when the extension launches for product usage statistics. The only information sent is an anonymous (hashed) agent ID and an API key provided by Agentity. No tool call data or user content is sent to Agentity.

*   **What is the performance impact of the audit?**
    The resource footprint is minimal. Log forwarding is performed asynchronously to avoid impacting the user experience. Any delay introduced is negligible compared to the overall processing time of a GitHub Copilot prompt.

*   **Do I need to check for extension updates?**
    By default, VS Code automatically updates extensions from the marketplace. We recommend leaving this setting enabled to ensure you receive the latest features and fixes.

*   **How can I submit a feature request?**
    We welcome your feedback! Please send your ideas and feature requests to support@agentity.com, or open an issue on GitHub.

## License
 
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Contact

For questions, support, or feature requests, please contact us at [support@agentity.com](mailto:support@agentity.com).