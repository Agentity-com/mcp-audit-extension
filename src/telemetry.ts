import { TelemetryReporter } from '@vscode/extension-telemetry';
import type { ExtensionContext } from 'vscode';
import { ExtensionMode } from 'vscode';

export let reporter: TelemetryReporter;

// Replace with your production connection string
const connectionString = 'InstrumentationKey=7ee3cf5b-e581-435a-8bbf-7e076d6dca05;IngestionEndpoint=https://centralus-2.in.applicationinsights.azure.com/;LiveEndpoint=https://centralus.livediagnostics.monitor.azure.com/;ApplicationId=3c0c9c34-4b85-4b72-b434-4df33362f2bd';

export function initializeTelemetry(context: ExtensionContext): void {
    const isProduction = context.extensionMode === ExtensionMode.Production;
    const key = isProduction ? connectionString : 'InstrumentationKey=00000000-0000-0000-0000-000000000000'; // Use an empty key for dev/test

    reporter = new TelemetryReporter(key);
    context.subscriptions.push(reporter);
}

export function getTelemetryReporter(): TelemetryReporter {
    if (!reporter) {
        // This is a fallback for when the reporter is not initialized.
        // In a real scenario, initializeTelemetry should be called at activation.
        const isProduction = process.env.NODE_ENV === 'production';
        reporter = new TelemetryReporter(isProduction ? connectionString : '');
    }
    return reporter;
}
