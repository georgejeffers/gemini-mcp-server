import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';

export interface MCPServerParameters {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv | null;
}

export interface MCPClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  call_tool(toolName: string): (args: any) => Promise<any>;
  list_tools(): Promise<any[]>;
}

export class MCPClientImpl implements MCPClient {
  private process: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private messageQueue: Buffer[] = [];
  private currentResolver: ((value: Buffer) => void) | null = null;
  private rpcInterface: {
    read: () => Promise<Buffer>;
    write: (data: Buffer) => Promise<void>;
  } | null = null;

  constructor(private serverParams: MCPServerParameters) {
    console.log('MCPClientImpl initialized with params:', {
      command: serverParams.command,
      args: serverParams.args,
      env: serverParams.env ? Object.keys(serverParams.env) : null
    });
  }

  async connect(): Promise<void> {
    console.log('Attempting to connect to MCP server...');
    return new Promise((resolve, reject) => {
      console.log('Spawning process:', this.serverParams.command, this.serverParams.args);
      this.process = spawn(this.serverParams.command, this.serverParams.args, {
        env: {
          ...process.env,
          ...this.serverParams.env
        }
      });

      if (!this.process) {
        const error = new Error('Failed to start MCP server process');
        console.error('Spawn failed:', error);
        reject(error);
        return;
      }

      console.log('Process spawned with PID:', this.process.pid);

      this.process.on('error', (err: Error) => {
        console.error('MCP server process error:', err);
        console.error('Error details:', {
          message: err.message,
          name: err.name,
          stack: err.stack
        });
        reject(new Error(`Failed to execute MCP server: ${err.message}`));
        this.process = null;
      });

      this.process.on('exit', (code: number, signal: string) => {
        console.warn(`MCP server process exited with code ${code} and signal ${signal}`);
        this.process = null;
      });

      let wsUrl = '';
      this.process.stdout?.on('data', (data: Buffer) => {
        const msg = data.toString('utf-8');
        console.log('MCP server stdout:', msg);
        const match = msg.match(/ws:\/\/localhost:\d+/);
        if (match) {
          wsUrl = match[0];
          console.log('WebSocket URL found:', wsUrl);
          this.createWebSocket(wsUrl).then(resolve).catch(reject);
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error(`MCP server stderr: ${data.toString('utf-8')}`);
      });
    });
  }

  private async createWebSocket(wsUrl: string): Promise<void> {
    console.log('Creating WebSocket connection to:', wsUrl);
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(wsUrl);

      this.socket.on('open', () => {
        console.log('WebSocket connection established');
        this.rpcInterface = {
          read: async () => {
            console.log('RPC read called');
            return new Promise<Buffer>((resolveRead) => {
              if (this.messageQueue.length > 0) {
                const message = Buffer.concat(this.messageQueue);
                this.messageQueue = [];
                console.log('Reading from message queue:', message.toString());
                resolveRead(message);
              } else {
                console.log('Waiting for message...');
                this.currentResolver = resolveRead;
              }
            });
          },
          write: async (data: Buffer) => {
            console.log('RPC write called with data:', data.toString());
            if (!this.socket?.readyState) {
              const error = new Error('WebSocket not connected');
              console.error('Write failed:', error);
              throw error;
            }
            this.socket.send(data);
            console.log('Data sent successfully');
          },
        };
        resolve();
      });

      this.socket.on('message', (data: WebSocket.Data) => {
        console.log('WebSocket message received:', data.toString());
        const buffer = Buffer.from(data as Buffer);
        if (this.currentResolver) {
          console.log('Resolving pending read');
          this.currentResolver(buffer);
          this.currentResolver = null;
        } else {
          console.log('Queueing message');
          this.messageQueue.push(buffer);
        }
      });

      this.socket.on('error', (err: Error) => {
        console.error('WebSocket error:', {
          message: err.message,
          name: err.name,
          stack: err.stack
        });
        reject(new Error(`WebSocket connection failed: ${err.message}`));
      });

      this.socket.on('close', (code: number, reason: Buffer) => {
        console.log(`WebSocket connection closed with code ${code}`, {
          reason: reason.toString(),
          wasClean: code === 1000
        });
      });

      // Add connection timeout
      setTimeout(() => {
        if (this.socket?.readyState !== WebSocket.OPEN) {
          const error = new Error('WebSocket connection timeout');
          console.error('Connection timeout:', error);
          reject(error);
        }
      }, 10000); // 10 second timeout
    });
  }

  async list_tools(): Promise<any[]> {
    if (!this.rpcInterface) {
      throw new Error('Not connected to MCP server');
    }

    const request = {
      jsonrpc: '2.0',
      method: 'list_tools',
      id: Math.floor(Math.random() * 1000000),
    };

    await this.rpcInterface.write(Buffer.from(JSON.stringify(request)));
    const response = await this.rpcInterface.read();
    const result = JSON.parse(response.toString());

    if (result.error) {
      throw new Error(result.error.message);
    }

    return result.result;
  }

  call_tool(toolName: string): (args: any) => Promise<any> {
    const rpcInterface = this.rpcInterface;
    if (!rpcInterface) {
      throw new Error('Not connected to MCP server');
    }

    return async (args: any) => {
      const request = {
        jsonrpc: '2.0',
        method: toolName,
        params: args,
        id: Math.floor(Math.random() * 1000000),
      };

      await rpcInterface.write(Buffer.from(JSON.stringify(request)));
      const response = await rpcInterface.read();
      const result = JSON.parse(response.toString());

      if (result.error) {
        throw new Error(result.error.message);
      }

      return result.result;
    };
  }

  async disconnect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close();
      this.socket = null;
    }

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
} 