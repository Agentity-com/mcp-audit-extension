import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Server } from 'http';

let isAuthEnabled = false;

const server = new FastMCP({
    name: 'Dummy Server',
    version: '1.0.0',
    oauth: {
        enabled: true,
        authorizationServer: {
            issuer: 'http://127.0.0.1:8080',
            authorizationEndpoint: 'http://127.0.0.1:8080/oauth/authorize',
            tokenEndpoint: 'http://127.0.0.1:8080/oauth/token',
            jwksUri: 'http://127.0.0.1:8080/.well-known/jwks.json',
            responseTypesSupported: ['code'],
            codeChallengeMethodsSupported: ['S256']
        },
    },
    authenticate: async (req) => {
        if (isAuthEnabled) {
            throw new Response(null, {
                status: 401,
                statusText: 'Missing or invalid authorization header',
                headers: {
                    'www-authenticate':
                        'Bearer error="Missing or invalid authorization header"',
                },
            });
        }
        return {
            userId: '',
            scope: '',
            email: '',
        };
    },
});

server.addTool({
    name: 'echo',
    description: 'Echoes the string provided',
    parameters: z.object({ s: z.string() }),
    execute: async (args) => args.s,
});

server.addTool({
    name: 'env',
    description: 'Returns the a string JSON of environment variables',
    execute: async () => JSON.stringify(process.env),
});

// Create Express server to setup OAuth, so that our MCP can act as both authorization and resource server
const app = express();

// Proxy /mcp to FastMCP server
app.use(
    '/',
    createProxyMiddleware({
        target: 'http://127.0.0.1:8081',
        logger: console,
        changeOrigin: true,
    })
);

app.use('/oauth/authorize', (req, res) => {
    res.status(200).json('hello');
});

if (require.main === module) {
    server.start({
        transportType: 'stdio',
    });
}

let expressServer: Server;

export async function startRemote(withAuth: boolean = false, enableJsonResponse: boolean = false) {
    isAuthEnabled = withAuth;
    await server.start({
        transportType: 'httpStream',
        httpStream: {
            port: 8081,
            enableJsonResponse
        },
    });

    // Start Express server
    expressServer = app.listen(8080, () => {
        console.log('Express proxy running on http://127.0.0.1:8080');
        console.log(
            'FastMCP endpoints: http://127.0.0.1:8081/mcp / http://127.0.0.1:8081/sse'
        );
    });
}

export async function stopRemote() {
    await server.stop();
    await expressServer.close();
}
