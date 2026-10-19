// src/background/mcp/transport.ts
export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: any;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

export class InMemoryTransport {
  private serverHandler: ((msg: JSONRPCMessage) => void) | null = null;
  private clientHandler: ((msg: JSONRPCMessage) => void) | null = null;
  private pendingRequests = new Map<string, (response: JSONRPCResponse) => void>();

  // Server side
  onServerMessage(handler: (msg: JSONRPCMessage) => void) {
    this.serverHandler = handler;
  }

  sendToServer(message: JSONRPCMessage) {
    this.serverHandler?.(message);
  }

  // Client side
  onClientMessage(handler: (msg: JSONRPCMessage) => void) {
    this.clientHandler = handler;
  }

  sendToClient(message: JSONRPCMessage) {
    this.clientHandler?.(message);
  }

  // Request/response helpers
  async request(method: string, params: any): Promise<any> {
    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, (response) => {
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      });
      this.sendToServer({ jsonrpc: '2.0', id, method, params });
    });
  }

  handleResponse(response: JSONRPCResponse) {
    const resolver = this.pendingRequests.get(response.id);
    if (resolver) {
      this.pendingRequests.delete(response.id);
      resolver(response);
    }
  }

  notify(method: string, params?: any) {
    this.sendToServer({ jsonrpc: '2.0', method, params });
  }
}