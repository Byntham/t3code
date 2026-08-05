/**
 * GrokSkills — filesystem discovery of Grok Build skills for the `$` picker.
 *
 * Grok loads skills from `~/.grok/skills` (user scope) and
 * `<cwd>/.grok/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The Grok ACP handshake does not
 * surface skills for T3's provider snapshot, so the provider scans the same
 * locations directly — mirroring Claude skill discovery for the `$` picker.
 *
 * @module provider/Drivers/GrokSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type GrokSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly name?: string;
      readonly description?: string;
      readonly shortDescription?: string;
    };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";

  // Grok promotes metadata.short-description for UI chips; optional.
  let shortDescription = "";
  const metadata = record.metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const short = (metadata as Record<string, unknown>)["short-description"];
    if (typeof short === "string") {
      shortDescription = short.trim();
    }
  }

  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(shortDescription ? { shortDescription } : {}),
  };
}

/**
 * Resolve the Grok home directory. Precedence matches common CLI/config
 * conventions: an explicit `homePath` override (for tests), then `GROK_HOME`
 * from the process environment, then `~/.grok`.
 */
const resolveGrokHomePath = Effect.fn("resolveGrokHomePath")(function* (
  homePath: string | undefined,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const explicitHome = homePath?.trim() ?? "";
  if (explicitHome.length > 0) {
    return path.resolve(expandHomePath(explicitHome));
  }
  // Env vars are never shell-expanded, so keep a literal `~` literal. A
  // relative value is resolved against the workspace cwd — the subprocess
  // cwd — so discovery scans the same directory the runtime would.
  const environmentHome = environment.GROK_HOME?.trim() ?? "";
  if (environmentHome.length > 0) {
    return cwd ? path.resolve(cwd, environmentHome) : path.resolve(environmentHome);
  }
  return path.join(NodeOS.homedir(), ".grok");
});

/**
 * Enumerate Grok Build skills from the user home and the workspace.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped so a broken skill never degrades the provider snapshot. On name
 * collisions the project-scoped skill wins, matching Grok's higher-priority
 * project/local override of user skills.
 */
export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  options: { readonly homePath?: string } = {},
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirPath = yield* resolveGrokHomePath(options.homePath, environment ?? process.env, cwd);

  const roots: ReadonlyArray<{ directory: string; scope: GrokSkillScope }> = [
    { directory: path.join(homeDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".grok", "skills"), scope: "project" as const }] : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in Grok either —
      // skip it rather than surfacing a broken entry under its directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.shortDescription
          ? { shortDescription: frontmatter.shortDescription }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
