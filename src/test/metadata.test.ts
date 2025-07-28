import { getAgentId, getHostName, getIpAddress } from '../metadata';
import { expect } from 'chai';
import type * as vscode from 'vscode';
import * as os from 'os';

describe('Metadata Functions (Integration)', () => {
    describe('getHostName', () => {
        it('should return a non-empty string', () => {
            const hostname = getHostName();
            expect(hostname).to.be.a('string');
            expect(hostname.length).to.be.greaterThan(0);
        });
    });

    describe('getIpAddress', () => {
        it('should return a valid IPv4 address string or undefined', () => {
            const ipAddress = getIpAddress();
            if (ipAddress) {
                expect(ipAddress).to.be.a('string');
                // Simple regex to check for IPv4 format
                expect(require('net').isIPv4(ipAddress)).to.be.true;
            } else {
                expect(ipAddress).to.be.undefined;
            }
        });
    });

    describe('getAgentId (Integration Test)', () => {
        // Helper to create a mock for VS Code's Memento (storage)
        const createMockStorage = (): vscode.Memento => {
            let internalStore: { [key: string]: any } = {};
            return {
                get: <T>(key: string, defaultValue?: T): T | undefined => {
                    return internalStore[key] || defaultValue;
                },
                update: (key: string, value: any): Promise<void> => {
                    internalStore[key] = value;
                    return Promise.resolve();
                },
                keys: (): readonly string[] => Object.keys(internalStore),
            };
        };
        let mockStorage: vscode.Memento;

        const platform = os.platform();
        console.log(`Platform is ${platform}`);

        beforeEach(() => {
            mockStorage = createMockStorage();
        });

        // Using `function` so we can use `this.skip()`
        it('should generate a valid agent ID, store it, and retrieve it', async function () {
            if (!['win32', 'darwin', 'linux'].includes(platform)) {
                console.log(
                    `Skipping getAgentId integration test on unsupported platform: ${platform}`
                );
                this.skip(); // Mocha's way of skipping a test
            }

            // 1. Call getAgentId for the first time
            const agentId1 = await getAgentId(mockStorage);

            // Assert that the generated ID is a valid SHA256 hash
            expect(agentId1).to.not.be.undefined;
            expect(agentId1).to.be.a('string');
            expect(agentId1).to.match(/^[a-f0-9]{64}$/);

            // Assert that the ID was stored in our mock storage
            const storedId = mockStorage.get<string>('agentId');
            expect(storedId).to.equal(agentId1);

            // 2. Call it a second time
            const agentId2 = await getAgentId(mockStorage);

            // Assert that the second ID is the same as the first
            expect(agentId2).to.equal(agentId1);
        });

        it('should retrieve value from storage when available', async () => {
            const mockAgentId = 'mock-agent-id';
            await mockStorage.update('agentId', mockAgentId);
            const agentId = await getAgentId(mockStorage);
            expect(agentId).to.equal(mockAgentId);
        });
    });
});
