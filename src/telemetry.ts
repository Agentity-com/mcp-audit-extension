import type { ExtensionContext } from "vscode";

// Define a common interface that both the real and mock reporters will adhere to.
// This ensures type safety within your application.
export interface ITelemetryReporter {
    dispose(): void;
    sendTelemetryEvent(eventName: string, properties?: { [key: string]: string }, measurements?: { [key: string]: number }): void;
}

let reporter: ITelemetryReporter;
export let initializeTelemetry: (context: ExtensionContext) => void;
export let getTelemetryReporter: () => ITelemetryReporter;

const connectionString = 'InstrumentationKey=7ee3cf5b-e581-435a-8bbf-7e076d6dca05;IngestionEndpoint=https://centralus-2.in.applicationinsights.azure.com/;LiveEndpoint=https://centralus.livediagnostics.monitor.azure.com/;ApplicationId=3c0c9c34-4b85-4b72-b434-4df33362f2bd';
const dummyConnectionString = 'InstrumentationKey=00000000-0000-0000-0000-000000000000';

try {
    // --- REAL IMPLEMENTATION (VS Code Environment) ---
    // This code runs when the extension is active in VS Code.
    const vscode = require('vscode');
    const { TelemetryReporter } = require('@vscode/extension-telemetry');

    initializeTelemetry = (context: ExtensionContext): void => {
        const isProduction = context.extensionMode === vscode.ExtensionMode.Production;
        const key = isProduction ? connectionString : dummyConnectionString;

        reporter = new TelemetryReporter(key);
        context.subscriptions.push(reporter);
    };

    getTelemetryReporter = (): ITelemetryReporter => {
        if (!reporter) {
            // Fallback if initializeTelemetry was not called.
            const isProduction = process.env.NODE_ENV === 'production';
            reporter = new TelemetryReporter(isProduction ? connectionString : '');
        }
        return reporter;
    };

} catch (error) {
    // --- MOCK IMPLEMENTATION (Test Environment) ---
    // This code runs when 'vscode' module is not found, e.g., in unit tests.

    // A simple mock class that implements the ITelemetryReporter interface.
    class MockTelemetryReporter implements ITelemetryReporter {
        constructor(public key: string) {}
        sendTelemetryEvent() {}
        dispose() {}
    }

    // This shouldn't run in UTs
    initializeTelemetry = (context: ExtensionContext): void => {};

    getTelemetryReporter = (): ITelemetryReporter => {
        if (!reporter) {
            // Fallback for tests.
            reporter = new MockTelemetryReporter(dummyConnectionString);
        }
        return reporter;
    };
}