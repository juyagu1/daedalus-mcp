#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import YAML from "yaml";
import { fileURLToPath } from "node:url";
import { initAgents, listGroups, listProjects, runAgentPipeline } from "./agentSystem.js";

const server = new McpServer({ name: "daedalus-mcp", version: "1.0.0" });

function clean<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

async function defaultWorkspacePath(workspacePath?: string): Promise<string | undefined> {
  if (workspacePath) return workspacePath;
  try {
    const roots = await server.server.listRoots();
    const first = roots.roots?.[0]?.uri;
    if (first?.startsWith("file://")) return fileURLToPath(first);
  } catch {
    // Host does not support roots/list; agentSystem will fall back to process.cwd().
  }
  return undefined;
}

function text(content: unknown) {
  return { content: [{ type: "text" as const, text: typeof content === "string" ? content : YAML.stringify(content) }] };
}


server.registerPrompt("daedalus", {
  title: "Daedalus slash command",
  description: "Usá este prompt como /daedalus. Ejemplos: init, listProjects, listGroups, plan/review --group:java-all \"tarea\".",
  argsSchema: {
    command: z.string().optional().describe("Comando sin el prefijo /daedalus. Ej: init, listProjects, plan --group:java-all \"agregar healthcheck\", review --project [api] \"revisar diff actual\".")
  }
}, async ({ command }) => {
  const normalized = command?.trim() ? `/daedalus ${command.trim()}` : "/daedalus init";
  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Ejecutá la tool MCP daedalus con este input exacto:\n\n${JSON.stringify({ command: normalized }, null, 2)}\n\nLuego resumí el resultado para el usuario. Si el resultado contiene un handoff porque el host no soporta sampling MCP, usá los prompts/contexto devueltos para completar el análisis en esta misma respuesta.`
        }
      }
    ]
  };
});

server.registerPrompt("daedalus-init", {
  title: "Daedalus init",
  description: "Inicializa Daedalus en el workspace actual. Equivale a /daedalus init."
}, async () => ({
  messages: [{ role: "user", content: { type: "text", text: 'Ejecutá la tool MCP daedalus con este input exacto: {"command":"/daedalus init"}. Luego resumí el resultado.' } }]
}));

server.registerTool("daedalus_init", {
  title: "Initialize Engineering Agents",
  description: "Escanea el workspace actual, crea templates reutilizables si faltan y genera agents.config.yaml + agents/ por proyecto sin pisar archivos existentes.",
  inputSchema: {
    workspacePath: z.string().optional().describe("Ruta opcional. Si se omite, usa el cwd/workspace actual del host MCP."),
    force: z.boolean().optional().describe("Pisa archivos de agentes/config de proyecto existentes."),
    refreshProjectKnowledge: z.boolean().optional().describe("Regenera knowledge/project aunque ya exista."),
    refreshTemplates: z.boolean().optional().describe("Regenera templates reutilizables aunque ya existan."),
    maxDepth: z.number().int().min(0).max(8).optional().describe("Profundidad máxima de escaneo de proyectos dentro del workspace.")
  }
}, async (args) => {
  const result = await initAgents(clean({ ...args, workspacePath: await defaultWorkspacePath(args.workspacePath) }));
  return text({
    command: "/daedalus init",
    workspace: result.config.workspace,
    projects: result.config.projects.map((p) => ({ name: p.name, path: p.path, stack: p.stack, architecture: p.architecture })),
    groups: result.config.groups,
    configPath: result.configPath,
    createdCount: result.created.length,
    skippedCount: result.skipped.length,
    created: result.created,
    skipped: result.skipped
  });
});

server.registerTool("daedalus_listProjects", {
  title: "List scanned projects",
  description: "Lista los proyectos detectados por /daedalus init en el workspace actual.",
  inputSchema: { workspacePath: z.string().optional() }
}, async ({ workspacePath }) => text({ command: "/daedalus listProjects", projects: await listProjects(await defaultWorkspacePath(workspacePath)) }));

server.registerTool("daedalus_listGroups", {
  title: "List project groups",
  description: "Lista grupos disponibles como all, java-all o angular-all generados por /daedalus init.",
  inputSchema: { workspacePath: z.string().optional() }
}, async ({ workspacePath }) => text({ command: "/daedalus listGroups", groups: await listGroups(await defaultWorkspacePath(workspacePath)) }));

server.registerTool("daedalus_run", {
  title: "Run agent pipeline",
  description: "Ejecuta un pipeline como plan o review sobre un grupo o lista de proyectos y devuelve un reporte por agente/proyecto.",
  inputSchema: {
    pipeline: z.string().default("plan").describe("Nombre del pipeline, por ejemplo plan o review."),
    task: z.string().describe("Tarea/requerimiento a analizar."),
    group: z.string().optional().describe("Grupo, por ejemplo java-all, angular-all o all."),
    projects: z.array(z.string()).optional().describe("Lista explícita de proyectos, equivalente a --project [a,b]."),
    workspacePath: z.string().optional()
  }
}, async ({ pipeline, task, group, projects, workspacePath }) => {
  const report = await runAgentPipeline({
    ...clean({ pipeline, task, group, projects, workspacePath: await defaultWorkspacePath(workspacePath) }),
    pipeline,
    task,
    sample: createSampler()
  });
  return text(report);
});

server.registerTool("daedalus_review", {
  title: "Run Daedalus code review",
  description: "Ejecuta el pipeline review: code-review -> rules -> performance -> architecture, usando mejores prácticas del lenguaje y reglas del proyecto.",
  inputSchema: {
    task: z.string().describe("Código, diff, archivos o descripción del cambio a revisar."),
    group: z.string().optional().describe("Grupo, por ejemplo java-all, angular-all o all."),
    projects: z.array(z.string()).optional().describe("Lista explícita de proyectos, equivalente a --project [a,b]."),
    workspacePath: z.string().optional()
  }
}, async ({ task, group, projects, workspacePath }) => {
  const report = await runAgentPipeline({
    ...clean({ group, projects, workspacePath: await defaultWorkspacePath(workspacePath) }),
    pipeline: "review",
    task,
    sample: createSampler()
  });
  return text(report);
});

server.registerTool("daedalus", {
  title: "Agent command parser",
  description: "Parser conveniente para comandos estilo `/daedalus init`, `/daedalus listProjects`, `/daedalus plan --group:java-all \"tarea\"`, `/daedalus review --project [a,b] \"revisar diff\"`. También acepta `/agent` por compatibilidad.",
  inputSchema: { command: z.string(), workspacePath: z.string().optional() }
}, async ({ command, workspacePath }) => {
  const parsed = parseAgentCommand(command);
  if (parsed.kind === "init") return text(await initAgents(clean({ workspacePath: await defaultWorkspacePath(workspacePath) })));
  if (parsed.kind === "listProjects") return text({ command: "/daedalus listProjects", projects: await listProjects(await defaultWorkspacePath(workspacePath)) });
  if (parsed.kind === "listGroups") return text({ command: "/daedalus listGroups", groups: await listGroups(await defaultWorkspacePath(workspacePath)) });
  if (parsed.kind !== "run") throw new Error("Comando no reconocido");
  const report = await runAgentPipeline({ ...clean({ group: parsed.group, projects: parsed.projects, workspacePath: await defaultWorkspacePath(workspacePath) }), pipeline: parsed.pipeline, task: parsed.task, sample: createSampler() });
  return text(report);
});


// Backward-compatible aliases for the original naming. Prefer daedalus_* tools going forward.
server.registerTool("agent_init", {
  title: "Initialize Engineering Agents (legacy alias)",
  description: "Alias legacy de daedalus_init.",
  inputSchema: { workspacePath: z.string().optional(), force: z.boolean().optional(), refreshProjectKnowledge: z.boolean().optional(), refreshTemplates: z.boolean().optional(), maxDepth: z.number().int().min(0).max(8).optional() }
}, async (args) => text(await initAgents(clean({ ...args, workspacePath: await defaultWorkspacePath(args.workspacePath) }))));

server.registerTool("agent", {
  title: "Agent command parser (legacy alias)",
  description: "Alias legacy de daedalus. Acepta /agent y /daedalus.",
  inputSchema: { command: z.string(), workspacePath: z.string().optional() }
}, async ({ command, workspacePath }) => {
  const parsed = parseAgentCommand(command);
  if (parsed.kind === "init") return text(await initAgents(clean({ workspacePath: await defaultWorkspacePath(workspacePath) })));
  if (parsed.kind === "listProjects") return text({ command: "/daedalus listProjects", projects: await listProjects(await defaultWorkspacePath(workspacePath)) });
  if (parsed.kind === "listGroups") return text({ command: "/daedalus listGroups", groups: await listGroups(await defaultWorkspacePath(workspacePath)) });
  if (parsed.kind !== "run") throw new Error("Comando no reconocido");
  const report = await runAgentPipeline({ ...clean({ group: parsed.group, projects: parsed.projects, workspacePath: await defaultWorkspacePath(workspacePath) }), pipeline: parsed.pipeline, task: parsed.task, sample: createSampler() });
  return text(report);
});

function createSampler(): (prompt: string) => Promise<string> {
  let samplingUnavailable: string | undefined;
  return async (prompt: string) => {
    if (samplingUnavailable) return samplingHandoff(prompt, samplingUnavailable);
    try {
      const response = await server.server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens: 1200
      });
      return response.content.type === "text" ? response.content.text : JSON.stringify(response.content);
    } catch (error) {
      samplingUnavailable = error instanceof Error ? error.message : String(error);
      return samplingHandoff(prompt, samplingUnavailable);
    }
  };
}

function samplingHandoff(prompt: string, reason: string): string {
  return `Sampling MCP no disponible en este host (${reason}). Daedalus no puede invocar el modelo desde el servidor, así que entrega este handoff para que el asistente host ejecute el paso en su respuesta final.

## Prompt preparado para este agente

\`\`\`md
${prompt.slice(0, 8000)}
\`\`\``;
}

function parseAgentCommand(raw: string):
  | { kind: "init" | "listProjects" | "listGroups" }
  | { kind: "run"; pipeline: string; task: string; group?: string; projects?: string[] } {
  const command = raw.trim().replace(/^\/(agent|daedalus)\s+/, "");
  if (command === "init") return { kind: "init" };
  if (command === "listProjects") return { kind: "listProjects" };
  if (command === "listGroups") return { kind: "listGroups" };
  const pipeline = command.split(/\s+/)[0] || "plan";
  const group = command.match(/--group:([\w.-]+)/)?.[1];
  const projectMatch = command.match(/--project\s*\[([^\]]+)\]/);
  const projects = projectMatch?.[1]?.split(",").map((p) => p.trim()).filter(Boolean);
  const quoted = [...command.matchAll(/"([^"]+)"|'([^']+)'/g)].at(-1);
  const task = quoted?.[1] ?? quoted?.[2] ?? command.replace(pipeline, "").replace(/--group:[\w.-]+/, "").replace(/--project\s*\[[^\]]+\]/, "").trim();
  if (!task) throw new Error("Falta la tarea. Ejemplo: /daedalus review --group:java-all \"revisar el diff actual\"");
  return { kind: "run", pipeline, task, ...(group ? { group } : {}), ...(projects?.length ? { projects } : {}) };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
