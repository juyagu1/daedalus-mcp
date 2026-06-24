import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export type ProjectInfo = {
  name: string;
  path: string;
  language: string;
  languageVersion?: string;
  framework?: string;
  frameworkVersion?: string;
  architecture: string;
  buildTool?: string;
  packageManager?: string;
  stack: string;
  groupKeys: string[];
  indicators: string[];
};

export type WorkspaceConfig = {
  version: number;
  workspace: { root: string; mode: "single-project" | "multi-project"; scannedAt: string };
  projects: ProjectInfo[];
  groups: Record<string, { description: string; projects: string[]; selector?: Record<string, string> | "*" }>;
};

export type InitOptions = {
  workspacePath?: string | undefined;
  force?: boolean | undefined;
  refreshProjectKnowledge?: boolean | undefined;
  refreshTemplates?: boolean | undefined;
  maxDepth?: number | undefined;
};

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "target", "build", "dist", ".next", ".angular", ".idea", ".vscode",
  "coverage", ".codebase-memory", "agents", "templates", ".engineering-agents"
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const templatesRoot = path.join(repoRoot, "templates");

export async function initAgents(options: InitOptions = {}): Promise<{ config: WorkspaceConfig; created: string[]; skipped: string[]; configPath: string }> {
  const workspaceRoot = path.resolve(options.workspacePath ?? process.env.INIT_CWD ?? process.cwd());
  const projects = await scanWorkspace(workspaceRoot, options.maxDepth ?? 3);
  const groups = buildGroups(projects);
  const config: WorkspaceConfig = {
    version: 1,
    workspace: {
      root: workspaceRoot,
      mode: projects.length > 1 ? "multi-project" : "single-project",
      scannedAt: new Date().toISOString()
    },
    projects,
    groups
  };

  const created: string[] = [];
  const skipped: string[] = [];

  await ensureDir(templatesRoot);
  for (const project of projects) {
    const templateKeys = templatesForProject(project);
    for (const key of templateKeys) {
      const result = await ensureTemplate(key, project, { force: options.refreshTemplates ?? false });
      (result.created ? created : skipped).push(result.path);
    }
    const projectResult = await ensureProjectAgents(workspaceRoot, project, templateKeys, {
      force: options.force ?? false,
      refreshProjectKnowledge: options.refreshProjectKnowledge ?? false
    });
    created.push(...projectResult.created);
    skipped.push(...projectResult.skipped);
  }

  const configDir = path.join(workspaceRoot, ".engineering-agents");
  await ensureDir(configDir);
  const configPath = path.join(configDir, "workspace.agents.yaml");
  await writeFileNoOverwrite(configPath, YAML.stringify(config), { force: true });
  created.push(configPath);

  return { config, created, skipped, configPath };
}

export async function listProjects(workspacePath?: string): Promise<ProjectInfo[]> {
  const config = await readWorkspaceConfig(workspacePath);
  return config.projects;
}

export async function listGroups(workspacePath?: string): Promise<WorkspaceConfig["groups"]> {
  const config = await readWorkspaceConfig(workspacePath);
  return config.groups;
}

export async function runAgentPipeline(params: {
  pipeline: string;
  task: string;
  group?: string | undefined;
  projects?: string[] | undefined;
  workspacePath?: string | undefined;
  sample?: ((prompt: string) => Promise<string>) | undefined;
}): Promise<string> {
  const config = await readWorkspaceConfig(params.workspacePath);
  const selected = selectProjects(config, params.group, params.projects);
  const lines: string[] = [
    `# Agent Report: ${params.pipeline}`,
    "",
    `## Task`,
    params.task,
    "",
    `## Scope`,
    params.group ? `Group: ${params.group}` : params.projects?.length ? `Projects: ${params.projects.join(", ")}` : "Current/default: all",
    "",
    `## Projects analyzed`,
    ...selected.map((p) => `- ${p.name} (${p.stack}, ${p.architecture})`),
    ""
  ];

  for (const project of selected) {
    lines.push(`## Project: ${project.name}`, "");
    const projectConfig = await readProjectAgentConfig(config.workspace.root, project);
    const pipeline = projectConfig?.pipelines?.[params.pipeline]?.steps ?? defaultPipelineSteps(params.pipeline);
    let input = params.task;
    for (const step of pipeline) {
      const prompt = await buildAgentPrompt(config.workspace.root, project, step, input, params.task);
      const output = params.sample ? await params.sample(prompt) : fallbackAgentOutput(project, step, input);
      lines.push(`### ${step}`, "", output, "");
      input = output;
    }
    lines.push(`### Result`, "", input, "");
  }

  lines.push("## Consolidated recommendation", "", "Revisá las secciones por proyecto/agente anteriores. Si el host MCP soporta sampling, cada sección contiene la evaluación generada por el modelo. Si no soporta sampling, Daedalus devuelve un reporte/handoff sin error para que el asistente host ejecute el razonamiento usando el contexto preparado.");
  return lines.join("\n");
}

function defaultPipelineSteps(pipeline: string): string[] {
  if (pipeline === "review" || pipeline === "code-review") return ["code-review", "rules", "performance", "architecture"];
  return ["plan", "rules", "performance", "architecture"];
}

async function scanWorkspace(root: string, maxDepth: number): Promise<ProjectInfo[]> {
  const candidates: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await safeReadDir(dir);
    const names = new Set(entries.map((e) => e.name));
    if (isProjectDir(names)) {
      candidates.push(dir);
      // Still walk common monorepo containers, but don't descend into build/output dirs.
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  const unique = [...new Set(candidates)];
  const projects = (await Promise.all(unique.map((dir) => detectProject(dir, root)))).filter(Boolean) as ProjectInfo[];
  if (projects.length === 0) {
    projects.push(await detectProject(root, root, true));
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

function isProjectDir(names: Set<string>): boolean {
  return names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts") || names.has("package.json") || names.has("angular.json") || names.has("pyproject.toml") || names.has("go.mod");
}

async function detectProject(dir: string, root: string, fallback = false): Promise<ProjectInfo> {
  const rel = path.relative(root, dir) || ".";
  const name = path.basename(dir) || path.basename(root);
  const indicators: string[] = [];
  let language = "unknown";
  let languageVersion: string | undefined;
  let framework: string | undefined;
  let frameworkVersion: string | undefined;
  let buildTool: string | undefined;
  let packageManager: string | undefined;

  const pom = await readIfExists(path.join(dir, "pom.xml"));
  const gradle = await readIfExists(path.join(dir, "build.gradle")) ?? await readIfExists(path.join(dir, "build.gradle.kts"));
  const pkgRaw = await readIfExists(path.join(dir, "package.json"));
  const angular = await exists(path.join(dir, "angular.json"));

  if (pom || gradle) {
    language = "java";
    buildTool = pom ? "maven" : "gradle";
    indicators.push(buildTool);
    const source = `${pom ?? ""}\n${gradle ?? ""}`;
    languageVersion = matchFirst(source, [/<java\.version>([^<]+)<\/java\.version>/, /<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/, /sourceCompatibility\s*=\s*['\"]?([0-9.]+)/, /JavaVersion\.VERSION_(\d+)/]);
    if (/spring-boot|org\.springframework\.boot/i.test(source)) {
      framework = "spring-boot";
      frameworkVersion = matchFirst(source, [/<spring-boot\.version>([^<]+)<\/spring-boot\.version>/, /org\.springframework\.boot['\"]?\s*version\s*['\"]([^'\"]+)/]);
      indicators.push("spring-boot");
    } else if (/quarkus/i.test(source)) {
      framework = "quarkus";
      indicators.push("quarkus");
    }
  }

  if (pkgRaw) {
    const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string; engines?: Record<string, string> };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    packageManager = pkg.packageManager?.split("@")[0] ?? (await exists(path.join(dir, "pnpm-lock.yaml")) ? "pnpm" : await exists(path.join(dir, "yarn.lock")) ? "yarn" : "npm");
    indicators.push("package.json", packageManager);
    if (deps["@angular/core"] || angular) {
      language = "typescript";
      framework = "angular";
      frameworkVersion = deps["@angular/core"];
      indicators.push("angular");
    } else if (deps["@nestjs/core"]) {
      language = "typescript";
      framework = "nestjs";
      frameworkVersion = deps["@nestjs/core"];
      indicators.push("nestjs");
    } else if (deps.react) {
      language = "typescript";
      framework = "react";
      frameworkVersion = deps.react;
      indicators.push("react");
    } else if (language === "unknown") {
      language = deps.typescript ? "typescript" : "javascript";
    }
    languageVersion = languageVersion ?? pkg.engines?.node;
  }

  if (await exists(path.join(dir, "pyproject.toml"))) {
    language = "python";
    buildTool = "pyproject";
    indicators.push("pyproject.toml");
  }
  if (await exists(path.join(dir, "go.mod"))) {
    language = "go";
    buildTool = "go-modules";
    indicators.push("go.mod");
  }

  const architecture = await detectArchitecture(dir, framework, indicators);
  const stack = stackKey(language, languageVersion, framework);
  return {
    name: rel === "." ? name : rel.replaceAll(path.sep, "-"),
    path: rel,
    language,
    ...(languageVersion ? { languageVersion: cleanVersion(languageVersion) } : {}),
    ...(framework ? { framework } : {}),
    ...(frameworkVersion ? { frameworkVersion: cleanVersion(frameworkVersion) } : {}),
    architecture,
    ...(buildTool ? { buildTool } : {}),
    ...(packageManager ? { packageManager } : {}),
    stack,
    groupKeys: groupKeysFor(language, framework, stack),
    indicators: fallback ? ["fallback-current-directory"] : indicators
  };
}

async function detectArchitecture(dir: string, framework: string | undefined, indicators: string[]): Promise<string> {
  const entries = await safeReadDir(dir);
  const names = entries.map((e) => e.name.toLowerCase());
  const srcEntries = await safeReadDir(path.join(dir, "src"));
  const srcNames = srcEntries.map((e) => e.name.toLowerCase());
  if (names.includes("dockerfile") || names.includes("docker-compose.yml") || framework === "spring-boot" || framework === "nestjs") indicators.push("service-runtime");
  const structure = [...names, ...srcNames].join(" ");
  if (/domain|application|infrastructure/.test(structure)) return "hexagonal-ddd";
  if (framework === "angular" || framework === "react") return "frontend";
  if (framework === "nestjs" && /bff/.test(dir.toLowerCase())) return "bff";
  if (framework === "spring-boot" || framework === "nestjs") return "microservice";
  return "standard";
}

function buildGroups(projects: ProjectInfo[]): WorkspaceConfig["groups"] {
  const groups: WorkspaceConfig["groups"] = {
    all: { description: "Todos los proyectos detectados", projects: projects.map((p) => p.name), selector: "*" }
  };
  for (const project of projects) {
    for (const key of project.groupKeys) {
      groups[key] ??= { description: `Proyectos del grupo ${key}`, projects: [], selector: selectorForGroup(key) };
      groups[key].projects.push(project.name);
    }
  }
  return groups;
}

function groupKeysFor(language: string, framework: string | undefined, stack: string): string[] {
  const keys = [`${language}-all`, `${stack}-all`];
  if (framework) keys.push(`${framework}-all`);
  return [...new Set(keys.filter((k) => !k.startsWith("unknown")))] ;
}

function selectorForGroup(key: string): Record<string, string> {
  if (key.endsWith("-all")) return { group: key.slice(0, -4) };
  return { group: key };
}

function templatesForProject(project: ProjectInfo): string[] {
  const arch = `architecture-${project.architecture}`;
  const performance = project.language === "java" ? "performance-jvm" : project.language === "typescript" || project.language === "javascript" ? "performance-web-node" : `performance-${project.language}`;
  return [`${project.stack}-plan`, `${project.stack}-code-review`, "project-rules-validator", performance, arch];
}

async function ensureTemplate(key: string, project: ProjectInfo, opts: { force: boolean }): Promise<{ path: string; created: boolean }> {
  const dir = path.join(templatesRoot, key);
  const existed = await exists(dir);
  await ensureDir(path.join(dir, "knowledge"));
  const agentYaml = {
    key,
    name: titleize(key),
    description: templateDescription(key, project),
    version: "1.0.0",
    resources: { prompt: "prompt.md", knowledge: "knowledge/general.md" }
  };
  await writeFileNoOverwrite(path.join(dir, "agent.yaml"), YAML.stringify(agentYaml), { force: opts.force });
  await writeFileNoOverwrite(path.join(dir, "prompt.md"), defaultPromptForTemplate(key, project), { force: opts.force });
  await writeFileNoOverwrite(path.join(dir, "knowledge", "general.md"), defaultKnowledgeForTemplate(key, project), { force: opts.force });
  return { path: dir, created: !existed };
}

async function ensureProjectAgents(workspaceRoot: string, project: ProjectInfo, templateKeys: string[], opts: { force: boolean; refreshProjectKnowledge: boolean }): Promise<{ created: string[]; skipped: string[] }> {
  const projectRoot = resolveProjectRoot(workspaceRoot, project);
  const created: string[] = [];
  const skipped: string[] = [];
  const agentNames = ["plan", "code-review", "rules", "performance", "architecture"];
  const projectConfig = {
    version: 1,
    project,
    agents: agentNames.map((name, i) => ({ name, template: templateKeys[i], role: name })),
    pipelines: {
      plan: { description: "Crea un plan técnico y lo valida contra reglas, performance y arquitectura.", steps: ["plan", "rules", "performance", "architecture"] },
      review: { description: "Hace code review con mejores prácticas del lenguaje y reglas propias del proyecto.", steps: ["code-review", "rules", "performance", "architecture"] }
    }
  };
  const cfgPath = path.join(projectRoot, "agents.config.yaml");
  (await writeFileNoOverwrite(cfgPath, YAML.stringify(projectConfig), { force: opts.force })).created ? created.push(cfgPath) : skipped.push(cfgPath);

  for (let i = 0; i < agentNames.length; i++) {
    const name = agentNames[i]!;
    const template = templateKeys[i]!;
    const dir = path.join(projectRoot, "agents", name);
    await ensureDir(path.join(dir, "knowledge", "general"));
    await ensureDir(path.join(dir, "knowledge", "project"));
    const files: Array<[string, string, boolean]> = [
      [path.join(dir, "agent.yaml"), YAML.stringify({ name, template, role: name, version: 1 }), opts.force],
      [path.join(dir, "prompt.md"), await readIfExists(path.join(templatesRoot, template, "prompt.md")) ?? defaultPromptForTemplate(template, project), opts.force],
      [path.join(dir, "knowledge", "general", "general.md"), projectAgentKnowledge(name, template, project), opts.refreshProjectKnowledge],
      [path.join(dir, "knowledge", "project", "rules.md"), projectRules(project), opts.refreshProjectKnowledge],
      [path.join(dir, "knowledge", "project", "structure.md"), await projectStructure(projectRoot), opts.refreshProjectKnowledge],
      [path.join(dir, "knowledge", "project", "dependencies.md"), await projectDependencies(projectRoot), opts.refreshProjectKnowledge],
      [path.join(dir, "knowledge", "project", "architecture.md"), projectArchitecture(project), opts.refreshProjectKnowledge]
    ];
    for (const [file, content, force] of files) {
      (await writeFileNoOverwrite(file, content, { force })).created ? created.push(file) : skipped.push(file);
    }
  }
  return { created, skipped };
}

async function readWorkspaceConfig(workspacePath?: string): Promise<WorkspaceConfig> {
  const root = path.resolve(workspacePath ?? process.env.INIT_CWD ?? process.cwd());
  const configPath = path.join(root, ".engineering-agents", "workspace.agents.yaml");
  const raw = await readIfExists(configPath);
  if (!raw) throw new Error(`No existe ${configPath}. Ejecutá primero /daedalus init.`);
  return YAML.parse(raw) as WorkspaceConfig;
}

function selectProjects(config: WorkspaceConfig, group?: string, projects?: string[]): ProjectInfo[] {
  let names: string[];
  if (projects?.length) names = projects;
  else if (group) {
    const g = config.groups[group];
    if (!g) throw new Error(`Grupo no encontrado: ${group}. Usá /daedalus listGroups.`);
    names = g.projects;
  } else names = config.groups.all?.projects ?? [];
  const byName = new Map(config.projects.map((p) => [p.name, p]));
  return names.map((name) => {
    const p = byName.get(name);
    if (!p) throw new Error(`Proyecto no encontrado: ${name}. Usá /daedalus listProjects.`);
    return p;
  });
}

async function readProjectAgentConfig(workspaceRoot: string, project: ProjectInfo): Promise<any | undefined> {
  const projectRoot = resolveProjectRoot(workspaceRoot, project);
  const raw = await readIfExists(path.join(projectRoot, "agents.config.yaml"));
  return raw ? YAML.parse(raw) : undefined;
}

async function buildAgentPrompt(workspaceRoot: string, project: ProjectInfo, step: string, input: string, originalTask: string): Promise<string> {
  const projectRoot = resolveProjectRoot(workspaceRoot, project);
  const agentDir = path.join(projectRoot, "agents", step);
  const prompt = await readIfExists(path.join(agentDir, "prompt.md")) ?? `Sos el agente ${step}.`;
  const knowledge = await collectMarkdown(path.join(agentDir, "knowledge"));
  return `${prompt}\n\n# Proyecto\n${YAML.stringify(project)}\n\n# Knowledge\n${knowledge}\n\n# Tarea original\n${originalTask}\n\n# Input a analizar\n${input}\n\nRespondé en español con hallazgos concretos y acciones recomendadas.`;
}

function fallbackAgentOutput(project: ProjectInfo, step: string, input: string): string {
  return `Daedalus preparó el contexto para el agente **${step}** en **${project.name}**, pero este host no expuso sampling MCP para ejecutar el modelo dentro del servidor.

- Stack detectado: ${project.stack}
- Arquitectura detectada: ${project.architecture}
- Input recibido: ${input}

El asistente host debe usar el prompt/contexto cargado por Daedalus para producir el análisis de este paso en la respuesta final.`;
}

function resolveProjectRoot(workspaceRoot: string, project: ProjectInfo): string {
  return path.resolve(project.path === "." ? workspaceRoot : path.join(workspaceRoot, project.path));
}

function stackKey(language: string, version?: string, framework?: string): string {
  const lang = language === "java" && version ? `java${cleanVersion(version).replace(/[^0-9].*$/, "") || cleanVersion(version)}` : language;
  return [lang, framework].filter(Boolean).join("-").replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
}

function cleanVersion(v: string): string { return v.replace(/[~^$\[\](){}'\"]/g, "").trim(); }
function titleize(key: string): string { return key.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "); }
function templateDescription(key: string, project: ProjectInfo): string {
  if (isGenericTemplate(key)) return `Template reutilizable ${key}.`;
  return `Template reutilizable ${key} para proyectos ${project.stack}/${project.architecture}.`;
}

function isGenericTemplate(key: string): boolean {
  return key === "project-rules-validator" || key.startsWith("performance-") || key.startsWith("architecture-");
}

function defaultPromptForTemplate(key: string, project: ProjectInfo): string {
  if (key.includes("code-review")) return `# Agente Code Review\n\nSos especialista en ${project.stack}. Revisá código, diffs o descripciones de cambios aplicando mejores prácticas del lenguaje/framework, calidad, mantenibilidad, seguridad básica, tests y compatibilidad con el proyecto. Devolvé hallazgos priorizados con evidencia y corrección sugerida.`;
  if (key.includes("rules")) return "# Agente Rules\n\nValidá que la propuesta cumpla las reglas, convenciones y restricciones particulares del proyecto. Marcá incumplimientos y correcciones.";
  if (key.includes("performance")) return "# Agente Performance\n\nEvaluá impactos de performance, latencia, memoria, IO, concurrencia y escalabilidad. Proponé optimizaciones concretas.";
  if (key.includes("architecture")) return "# Agente Architecture\n\nEvaluá la solución contra la arquitectura objetivo, límites de módulos, dependencias, contratos y mantenibilidad.";
  return `# Agente Plan\n\nSos especialista en ${project.stack}. Creá un plan técnico secuencial siguiendo buenas prácticas generales del stack y preparalo para validaciones posteriores.`;
}

function defaultKnowledgeForTemplate(key: string, project: ProjectInfo): string {
  if (key.includes("code-review")) {
    return `# Knowledge general: ${key}

- Revisá legibilidad, simplicidad, diseño, tipos, errores, seguridad básica, tests, compatibilidad y mantenibilidad.
- Aplicá mejores prácticas del lenguaje/framework detectado y pedí evidencia concreta del cambio revisado.
- Devolvé hallazgos accionables por severidad con archivo/símbolo si está disponible.
`;
  }
  if (key === "project-rules-validator") {
    return `# Knowledge general: ${key}

- Validá convenciones, reglas locales, estructura existente y restricciones documentadas del proyecto.
- No asumas un stack fijo: el stack real viene en knowledge/project y metadata del proyecto.
- Marcá incumplimientos con severidad, evidencia y corrección recomendada.
`;
  }
  if (key === "performance-jvm") {
    return `# Knowledge general: ${key}

- Revisá latencia, memoria, GC, pools de threads, conexiones HTTP/DB, N+1 queries, timeouts y backpressure.
- Preferí mediciones, límites explícitos, observabilidad y cambios incrementales.
`;
  }
  if (key === "performance-web-node") {
    return `# Knowledge general: ${key}

- Revisá bundle size, rendering, change detection, lazy loading, caching, llamadas HTTP, SSR/CSR y memoria del runtime Node/browser.
- Preferí mediciones, presupuestos de performance y cambios incrementales.
`;
  }
  if (key.startsWith("performance-")) {
    return `# Knowledge general: ${key}

- Revisá latencia, memoria, IO, concurrencia, caching, timeouts, observabilidad y escalabilidad.
`;
  }
  if (key.startsWith("architecture-")) {
    return `# Knowledge general: ${key}

- Validá límites arquitectónicos, dependencias, responsabilidades, contratos, mantenibilidad y consistencia con el estilo del proyecto.
- No asumas un stack fijo: el stack real viene en knowledge/project y metadata del proyecto.
`;
  }
  return `# Knowledge general: ${key}

- Stack objetivo: ${project.stack}.
- Lenguaje: ${project.language}${project.languageVersion ? ` ${project.languageVersion}` : ""}.
- Framework: ${project.framework ?? "no detectado"}.
- Arquitectura esperada: ${project.architecture}.
- Priorizá cambios pequeños, testeables, observables y compatibles con el estilo existente.
`;
}

function projectAgentKnowledge(agentName: string, template: string, project: ProjectInfo): string {
  const specialization = agentName === "code-review" ? "\n- Objetivo específico: revisar código/diffs contra mejores prácticas del lenguaje/framework y reglas propias del proyecto. Clasificá hallazgos por severidad (bloqueante, alto, medio, bajo) e incluí evidencia concreta." : "";
  return `# Knowledge general del agente ${agentName}

- Template base: ${template}.
- Proyecto: ${project.name}.
- Stack detectado: ${project.stack}.
- Lenguaje: ${project.language}${project.languageVersion ? ` ${project.languageVersion}` : ""}.
- Framework: ${project.framework ?? "no detectado"}.
- Arquitectura detectada: ${project.architecture}.
- Build/package manager: ${project.buildTool ?? project.packageManager ?? "no detectado"}.
- Priorizá cambios pequeños, testeables, observables y compatibles con el estilo existente.${specialization}
`;
}

function projectRules(project: ProjectInfo): string {
  return `# Reglas del proyecto ${project.name}\n\n- No asumir estructura externa: respetar carpetas y convenciones detectadas.\n- Stack detectado: ${project.stack}.\n- Arquitectura detectada: ${project.architecture}.\n- Build tool/package manager: ${project.buildTool ?? project.packageManager ?? "no detectado"}.\n- No pisar archivos existentes generados por agentes salvo que se solicite refresh/force.\n`;
}

function projectArchitecture(project: ProjectInfo): string {
  return `# Arquitectura del proyecto ${project.name}\n\n- Tipo detectado: ${project.architecture}.\n- Indicadores: ${project.indicators.join(", ") || "sin indicadores"}.\n- Grupos: ${project.groupKeys.join(", ")}.\n`;
}

async function projectStructure(projectRoot: string): Promise<string> {
  const lines = await tree(projectRoot, 2);
  return `# Estructura\n\n\`\`\`txt\n${lines.join("\n")}\n\`\`\`\n`;
}

async function projectDependencies(projectRoot: string): Promise<string> {
  const snippets: string[] = ["# Dependencias\n"];
  for (const file of ["pom.xml", "build.gradle", "build.gradle.kts", "package.json", "angular.json", "pyproject.toml", "go.mod"]) {
    const raw = await readIfExists(path.join(projectRoot, file));
    if (raw) snippets.push(`## ${file}\n\n\`\`\`\n${raw.slice(0, 4000)}\n\`\`\``);
  }
  return snippets.join("\n\n");
}

async function tree(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = (await safeReadDir(dir)).filter((e) => !IGNORE_DIRS.has(e.name)).slice(0, 80);
    for (const entry of entries) {
      out.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${prefix}  `, depth + 1);
    }
  }
  await walk(root, "", 0);
  return out;
}

async function collectMarkdown(dir: string): Promise<string> {
  const chunks: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const entry of await safeReadDir(d)) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith(".md")) chunks.push(`\n## ${path.relative(dir, p)}\n${await fs.readFile(p, "utf8")}`);
    }
  }
  await walk(dir);
  return chunks.join("\n");
}

function matchFirst(source: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

async function writeFileNoOverwrite(file: string, content: string, opts: { force?: boolean } = {}): Promise<{ created: boolean }> {
  await ensureDir(path.dirname(file));
  if (!opts.force && await exists(file)) return { created: false };
  await fs.writeFile(file, content, "utf8");
  return { created: true };
}
async function ensureDir(dir: string): Promise<void> { await fs.mkdir(dir, { recursive: true }); }
async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }
async function readIfExists(p: string): Promise<string | undefined> { try { return await fs.readFile(p, "utf8"); } catch { return undefined; } }
async function safeReadDir(p: string): Promise<import("node:fs").Dirent[]> { try { return await fs.readdir(p, { withFileTypes: true }); } catch { return []; } }
