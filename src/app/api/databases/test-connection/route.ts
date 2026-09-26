import { NextRequest, NextResponse } from 'next/server';
import net from 'net';

export const dynamic = 'force-dynamic';

function testTcpConnection(host: string, port: number, timeoutMs = 4000): Promise<{ reachable: boolean; latencyMs: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ reachable: true, latencyMs });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ reachable: false, latencyMs: timeoutMs, error: 'Connection timed out (no response within 4s)' });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ reachable: false, latencyMs: Date.now() - start, error: err.message });
    });

    socket.connect(port, host);
  });
}

export async function POST(req: NextRequest) {
  try {
    const { type, connectionString } = await req.json();

    if (!connectionString || typeof connectionString !== 'string') {
      return NextResponse.json({ success: false, error: 'Connection string is required' }, { status: 400 });
    }

    let host = '';
    let port = type === 'redis' ? 6379 : 5432;
    let dbName = '';
    let user = '';

    try {
      // Clean string
      const cleanUrl = connectionString.trim();
      const parsed = new URL(cleanUrl);
      host = parsed.hostname;
      if (parsed.port) {
        port = parseInt(parsed.port, 10);
      }
      user = parsed.username || '';
      dbName = parsed.pathname.replace(/^\//, '') || '';
    } catch {
      // Fallback regex extraction for host:port
      const match = connectionString.match(/@([^:/]+)(?::(\d+))?/);
      if (match) {
        host = match[1];
        if (match[2]) port = parseInt(match[2], 10);
      } else {
        const directMatch = connectionString.match(/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::(\d+))?/);
        if (directMatch) {
          host = directMatch[1];
          if (directMatch[2]) port = parseInt(directMatch[2], 10);
        }
      }
    }

    if (!host) {
      return NextResponse.json({
        success: false,
        error: 'Could not parse a valid hostname from the connection string. Example format: postgres://user:password@hostname.render.com:5432/dbname',
      }, { status: 400 });
    }

    // Perform real TCP handshake to target host and port
    const result = await testTcpConnection(host, port, 5000);

    if (result.reachable) {
      return NextResponse.json({
        success: true,
        type,
        host,
        port,
        user: user || undefined,
        database: dbName || undefined,
        latencyMs: result.latencyMs,
        message: `Connection to ${host}:${port} succeeded! TCP handshake completed in ${result.latencyMs}ms.`,
      });
    } else {
      return NextResponse.json({
        success: false,
        type,
        host,
        port,
        latencyMs: result.latencyMs,
        error: `Could not reach ${host}:${port}: ${result.error}. (Check firewall, allowed IPs, or credentials)`,
      }, { status: 502 });
    }
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
