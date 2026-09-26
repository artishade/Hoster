import { NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

// ─── Shapes ──────────────────────────────────────────────────────────────────

interface McpExecuteResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  executionMs?: number;
  logs: string[];
  raw?: boolean;
}

// ─── Small safe helpers (no `any`) ───────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return (m ? m[1] : trimmed).trim();
}

function extractCompletionContent(completion: unknown): string {
  if (!completion || typeof completion !== 'object') return '';
  const choices = (completion as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (!first || typeof first !== 'object') return '';
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Strict-JSON response parsing ────────────────────────────────────────────

function coerceMcpResult(rawText: string): McpExecuteResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(rawText));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;

  const logs = Array.isArray(rec.logs)
    ? rec.logs
        .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
        .slice(0, 5)
    : [];

  const out: McpExecuteResult = { ok: rec.ok === true, logs };

  if (out.ok) {
    out.result = rec.result ?? null;
    if (typeof rec.executionMs === 'number' && Number.isFinite(rec.executionMs)) {
      out.executionMs = Math.max(0, Math.round(rec.executionMs));
    }
    if (out.logs.length === 0) out.logs = ['runtime: execution completed'];
  } else {
    out.error =
      typeof rec.error === 'string' && rec.error.trim() ? rec.error.trim() : 'Tool execution failed';
    if (out.logs.length === 0) out.logs = ['runtime: execution failed'];
  }
  return out;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const rec = body as Record<string, unknown>;

    const toolName = typeof rec.toolName === 'string' ? rec.toolName.trim() : '';
    if (!toolName) {
      return NextResponse.json({ error: "'toolName' is required" }, { status: 400 });
    }
    const toolDescription = typeof rec.toolDescription === 'string' ? rec.toolDescription.trim() : '';

    const inputSchema: Record<string, unknown> = isPlainObject(rec.inputSchema) ? rec.inputSchema : {};

    let input: Record<string, unknown> = {};
    if (rec.input !== undefined) {
      if (!isPlainObject(rec.input)) {
        return NextResponse.json({ error: "'input' must be a JSON object" }, { status: 400 });
      }
      input = rec.input;
    }

    // Optional service context (name, type, description)
    let serviceName = 'unknown';
    let serviceContext = '';
    const serviceId = typeof rec.serviceId === 'string' ? rec.serviceId.trim() : '';
    if (serviceId) {
      const svc = await db.service.findUnique({
        where: { id: serviceId },
        select: { name: true, type: true, description: true },
      });
      if (svc) {
        serviceName = svc.name;
        serviceContext = `Service context: name=${svc.name}, type=${svc.type}, description=${svc.description || '(none)'}.`;
      } else {
        serviceContext = `Service context: no registered service matches id '${serviceId}'; execute the tool generically.`;
      }
    }

    const SYSTEM = [
      `You are the MCP tool runtime for NexusHost executing the tool '${toolName}' on service '${serviceName}'. Tool description: ${toolDescription || '(none provided)'}. Input JSON schema: ${JSON.stringify(inputSchema)}. Execute the tool call faithfully against the provided arguments and return a realistic, correct result. Respond with STRICT JSON only: { ok: true, result: <any JSON>, executionMs: number, logs: string[] (2-5 realistic execution log lines) }. If the arguments violate the schema, respond { ok: false, error: string, logs: string[] }.`,
      serviceContext,
    ]
      .filter(Boolean)
      .join('\n');

    let content: string;
    try {
      const zai = await ZAI.create();
      const completion: unknown = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: SYSTEM },
          { role: 'user', content: JSON.stringify(input) },
        ],
        thinking: { type: 'disabled' },
      });
      content = extractCompletionContent(completion);
    } catch (err) {
      return NextResponse.json({ error: `AI backend unavailable: ${errorMessage(err)}` }, { status: 502 });
    }

    const parsed = coerceMcpResult(content);
    if (parsed) {
      return NextResponse.json({ data: parsed });
    }

    // Parse failure → structured failure envelope so callers never crash on rendering
    const fallback: McpExecuteResult = {
      ok: false,
      error: 'Tool runtime returned unparseable output',
      logs: ['runtime: model response was not valid JSON'],
      raw: true,
    };
    return NextResponse.json({ data: fallback });
  } catch (err) {
    return NextResponse.json({ error: `MCP execution failed: ${errorMessage(err)}` }, { status: 500 });
  }
}
