// The local pedir-natan queue (~/.local/bin/pedir-natan, pedidos.db): questions
// other tools put to the person. Each one becomes a card in a conversation, with
// "pedido <id>" in its footer; a request can also be settled outside the app,
// by `pedir-natan responder` or by the bot itself with `pedir-natan resolver`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Pedido {
  id: string;
  createdAt: number;
  origin: string;
  title: string;
  text: string;
  /** In the order asked; `recommended` indexes it, -1 for none. */
  options: string[];
  recommended: number;
  open: boolean;
  answer?: string;
  /** Settled by the asking bot ("resolvido por <bot>: <como>"), not by the person. */
  resolved?: boolean;
  answeredAt?: number;
}

export interface PedirNatan {
  pedidos(): Pedido[];
  answer(id: string, text: string): Promise<void>;
}

const ANSWER_TIMEOUT_MS = 240_000;
export const PEDIDO_FOOTER = /—\s*de (.+?) · \d{1,2}:\d{2} · pedido ([0-9a-f]{8})\s*$/u;

export function pedidoOf(text: string): { id: string; origin: string } | null {
  const match = PEDIDO_FOOTER.exec(text);
  return match ? { id: match[2], origin: match[1] } : null;
}

export function createPedirNatan(options: {
  database?: string;
  command?: string;
  run?: (command: string, args: string[], timeoutMs: number) => Promise<void>;
} = {}): PedirNatan {
  const database = options.database ?? process.env.OMB_PEDIR_NATAN_DB ?? join(homedir(), ".local/state/pedir-natan/pedidos.db");
  const command = options.command ?? process.env.OMB_PEDIR_NATAN_BIN ?? join(homedir(), ".local/bin/pedir-natan");
  const run = options.run ?? runCommand;
  return {
    pedidos() {
      if (!existsSync(database)) return [];
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const rows = db.prepare("SELECT id, criado, origem, titulo, texto, opcoes, recomendada, estado, resposta, respondido_em FROM pedidos WHERE opcoes != '[]'")
          .all() as Array<Record<string, string | number | null>>;
        return rows.map(pedidoFromRow);
      } finally {
        db.close();
      }
    },
    answer: (id, text) => run(command, ["responder", id, text], ANSWER_TIMEOUT_MS),
  };
}

function pedidoFromRow(row: Record<string, string | number | null>): Pedido {
  const answer = parse<{ texto?: string; resolvido?: boolean }>(row.resposta);
  const open = row.estado === "novo" || row.estado === "aberto";
  return {
    id: String(row.id),
    createdAt: Date.parse(String(row.criado)) || 0,
    origin: String(row.origem ?? ""),
    title: String(row.titulo ?? ""),
    text: String(row.texto ?? ""),
    options: parse<string[]>(row.opcoes)?.map(String) ?? [],
    recommended: Number(row.recomendada ?? -1),
    open,
    ...(!open && answer?.texto ? { answer: answer.texto } : {}),
    ...(!open && answer?.resolvido === true ? { resolved: true } : {}),
    ...(!open && row.respondido_em ? { answeredAt: Date.parse(String(row.respondido_em)) || undefined } : {}),
  };
}

function parse<T>(value: string | number | null): T | null {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-300)));
      else resolve();
    });
  });
}
