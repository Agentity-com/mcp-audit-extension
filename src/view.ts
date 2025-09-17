import * as vscode from 'vscode';
import * as fs from 'fs';
import { extensionEvents } from './events';

class LogEntryItem extends vscode.TreeItem {
    constructor(
        public readonly label: string, // The text to display, e.g., a timestamp
        private readonly fullLogData: string // The full JSON string for this entry
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `View details for this tool call`;
        this.description = `Click to view full data`;
        
        // Set the command to be executed when the item is clicked
        this.command = {
            command: 'mcpExtension.showLogEntry',
            title: 'Show Log Entry',
            arguments: [this.fullLogData], // Pass the log data to the command
        };
    }
}

export class ToolCallLogProvider implements vscode.TreeDataProvider<LogEntryItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<LogEntryItem | undefined | null | void> = new vscode.EventEmitter<LogEntryItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<LogEntryItem | undefined | null | void> = this._onDidChangeTreeData.event;
    
    constructor(private logFilePath: string) {
        extensionEvents.on('logFileUpdated', () => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    
    getTreeItem(element: LogEntryItem): vscode.TreeItem {
        return element;
    }
    
    getChildren(element?: LogEntryItem): Thenable<LogEntryItem[]> {
        // Since this is a flat list, we only care about the root level (when element is undefined).
        if (element) {
            return Promise.resolve([]);
        }
        
        if (!fs.existsSync(this.logFilePath)) {
            return Promise.resolve([]);
        }
        
        const logContent = fs.readFileSync(this.logFilePath, 'utf-8');
        const logEntries = logContent
            .split('\n')
            .filter(line => line.trim() !== '')
            .slice(-1000); // Cap log lines in view to 1000
        
        const treeItems = logEntries.map(entry => {
            try {
                const parsed = JSON.parse(entry);
                // Assuming each log has a 'timestamp' or 'toolName' field for a good label
                // Format timestamp as "YYYY-MM-DD HH:mm" in local time
                const date = new Date(parsed.timestamp).toLocaleString(undefined, {
                    year: '2-digit',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                }).replace(',', '');
                const label = `${date} ${parsed.mcpServerName}.${parsed.toolName}`;
                return new LogEntryItem(label, entry);
            } catch (e) {
                // Handle malformed lines if necessary
                return new LogEntryItem('Malformed Log Entry', entry);
            }
        }).reverse(); // Show the most recent calls first
        
        return Promise.resolve(treeItems);
    }
}