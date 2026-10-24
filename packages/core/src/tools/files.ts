import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { HermesError } from '../shared/errors';
import { assertInsideRoots } from '../policy-engine/paths';
import { alwaysAvailable, defineTool, type ToolContext } from './types';
import { DOCUMENT_EXTENSIONS, DOCUMENT_LIMITS, extractDocument } from './documents';

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.jsonc',
  '.csv',
  '.tsv',
  '.log',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.sh',
  '.ps1',
  '.bat',
  '.toml',
  '.yaml',
  '.yml',
  '.ini',
  '.cfg',
  '.conf',
  '.env.example',
  '.sql',
  '.vue',
  '.svelte',
  '.gitignore',
  '.editorconfig',
  '.lock',
]);

const absPath = z.string().min(1).max(1024);

const roots = (ctx: ToolContext) => ctx.services.getPolicy().allowedRoots;

/** Glob subset: `*` (no separator), `**` (any depth), `?`. Matched against the path relative to the root. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  const p = pattern.replace(/\\/g, '/');
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

const FileEntry = z.object({
  path: z.string(),
  name: z.string(),
  extension: z.string(),
  size: z.number(),
  isDirectory: z.boolean(),
  modifiedAt: z.string(),
  createdAt: z.string(),
});

export const filesSearch = defineTool({
  id: 'files.search',
  description:
    'Recherche des fichiers dans un dossier autorisé. pattern: glob relatif (ex. "*.pdf", "**/*.ts"). Retourne chemins et métadonnées (taille, dates).',
  input: z.object({
    root: absPath,
    pattern: z.string().min(1).max(200).default('**/*'),
    maxResults: z.number().int().min(1).max(500).default(100),
    maxDepth: z.number().int().min(0).max(12).default(6),
    includeDirectories: z.boolean().default(false),
  }),
  output: z.object({
    root: z.string(),
    matches: z.array(FileEntry),
    truncated: z.boolean(),
    scanned: z.number(),
  }),
  allowedAgents: ['files', 'code', 'research', 'computer'],
  permissions: ['fs.read'],
  risk: 'low',
  timeoutMs: 30_000,
  reversible: true,
  idempotent: true,
  verification: 'Lecture seule : les métadonnées proviennent directement du système de fichiers.',
  confirmation: 'Aucune (lecture seule dans les dossiers autorisés).',
  availability: alwaysAvailable,
  resources: (i) => ({ paths: [{ path: i.root, access: 'read' }] }),
  async run(i, ctx) {
    const root = assertInsideRoots(i.root, roots(ctx));
    const re = globToRegExp(
      i.pattern.includes('/') || i.pattern.includes('\\') ? i.pattern : `**/${i.pattern}`,
    );
    const matches: z.infer<typeof FileEntry>[] = [];
    let scanned = 0;
    let truncated = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (truncated || ctx.signal.aborted) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable folder (permissions): skipped, not fatal
      }
      for (const e of entries) {
        if (truncated) return;
        // Links and junctions are never followed: they could point outside the allowed roots.
        if (e.isSymbolicLink()) continue;
        const full = join(dir, e.name);
        scanned++;
        const rel = relative(root, full).split(sep).join('/');
        if ((e.isFile() || (i.includeDirectories && e.isDirectory())) && re.test(rel)) {
          const s = await stat(full).catch(() => null);
          if (s) {
            matches.push({
              path: full,
              name: e.name,
              extension: extname(e.name).toLowerCase(),
              size: s.size,
              isDirectory: s.isDirectory(),
              modifiedAt: s.mtime.toISOString(),
              createdAt: s.birthtime.toISOString(),
            });
            if (matches.length >= i.maxResults) truncated = true;
          }
        }
        if (e.isDirectory() && depth < i.maxDepth && !e.name.startsWith('.') && e.name !== 'node_modules')
          await walk(full, depth + 1);
      }
    };
    await walk(root, 0);
    return { root, matches, truncated, scanned };
  },
});

export const filesRead = defineTool({
  id: 'files.read',
  description:
    'Lit un fichier autorisé : texte brut, ou texte extrait des documents PDF (100 pages max), DOCX (Markdown) et XLSX (feuilles en lignes tabulées). Pour un autre format binaire, retourne seulement ses métadonnées.',
  input: z.object({ path: absPath, maxBytes: z.number().int().min(1).max(1_000_000).default(200_000) }),
  output: z.object({
    path: z.string(),
    size: z.number(),
    modifiedAt: z.string(),
    readable: z.boolean(),
    content: z.string().nullable(),
    truncated: z.boolean(),
    sha256: z.string().nullable(),
    reason: z.string().optional(),
    document: z
      .object({
        format: z.enum(['pdf', 'docx', 'xlsx']),
        pages: z.number().nullable(),
        pagesRead: z.number().nullable(),
        metadata: z.record(z.string(), z.string().nullable()),
        sheets: z.array(z.object({ name: z.string(), rows: z.number(), truncated: z.boolean() })).nullable(),
        warnings: z.array(z.string()),
      })
      .optional(),
  }),
  allowedAgents: ['files', 'code', 'research', 'computer', 'browser', 'shell'],
  permissions: ['fs.read'],
  risk: 'low',
  timeoutMs: 60_000,
  reversible: true,
  idempotent: true,
  verification:
    'Lecture seule ; empreinte SHA-256 du fichier lu retournée comme preuve (documents : empreinte du fichier, texte extrait borné).',
  confirmation: 'Aucune (lecture seule dans les dossiers autorisés).',
  availability: alwaysAvailable,
  resources: (i) => ({ paths: [{ path: i.path, access: 'read' }] }),
  async run(i, ctx) {
    const p = assertInsideRoots(i.path, roots(ctx));
    const s = await lstat(p);
    if (s.isSymbolicLink()) throw new HermesError('POLICY_DENIED', 'Lecture via un lien symbolique refusée');
    if (!s.isFile()) throw new HermesError('VALIDATION', `Ce n'est pas un fichier : ${p}`);
    const ext = extname(p).toLowerCase() || basename(p).toLowerCase();
    const base = { path: p, size: s.size, modifiedAt: s.mtime.toISOString() };
    const format = DOCUMENT_EXTENSIONS[ext];
    if (format) {
      if (s.size > DOCUMENT_LIMITS.maxFileBytes)
        return {
          ...base,
          readable: false,
          content: null,
          truncated: false,
          sha256: null,
          reason: `Document trop volumineux pour l’extraction (> ${DOCUMENT_LIMITS.maxFileBytes / 1024 / 1024} Mo)`,
        };
      const buf = await readFile(p);
      let doc: Awaited<ReturnType<typeof extractDocument>>;
      try {
        doc = await extractDocument(buf, format);
      } catch (err) {
        // Corrupt, encrypted or unsupported document: reported, not a tool failure.
        return {
          ...base,
          readable: false,
          content: null,
          truncated: false,
          sha256: createHash('sha256').update(buf).digest('hex'),
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        ...base,
        readable: true,
        content: doc.text,
        truncated: doc.truncated,
        sha256: createHash('sha256').update(buf).digest('hex'),
        document: {
          format: doc.format,
          pages: doc.pages,
          pagesRead: doc.pagesRead,
          metadata: doc.metadata,
          sheets:
            doc.sheets?.map((x) => ({ name: x.name, rows: x.rows.length, truncated: x.truncated })) ?? null,
          warnings: doc.warnings,
        },
      };
    }
    if (!TEXT_EXTENSIONS.has(ext)) {
      return {
        ...base,
        readable: false,
        content: null,
        truncated: false,
        sha256: null,
        reason: `Format ${ext || 'inconnu'} non lu (métadonnées uniquement)`,
      };
    }
    const fh = await open(p, 'r');
    try {
      const len = Math.min(s.size, i.maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      if (buf.includes(0))
        return {
          ...base,
          readable: false,
          content: null,
          truncated: false,
          sha256: null,
          reason: 'Contenu binaire détecté',
        };
      return {
        ...base,
        readable: true,
        content: buf.toString('utf8'),
        truncated: s.size > i.maxBytes,
        sha256: createHash('sha256').update(buf).digest('hex'),
      };
    } finally {
      await fh.close();
    }
  },
});

export const filesWrite = defineTool({
  id: 'files.write',
  description:
    'Écrit un fichier texte dans un dossier autorisé. mode "create" (défaut) échoue si le fichier existe ; "overwrite" et "append" demandent une approbation et sauvegardent l’original.',
  input: z.object({
    path: absPath,
    content: z.string().max(2_000_000),
    mode: z.enum(['create', 'overwrite', 'append']).default('create'),
    createDirs: z.boolean().default(true),
  }),
  output: z.object({
    path: z.string(),
    bytesWritten: z.number(),
    sha256: z.string(),
    created: z.boolean(),
    backupPath: z.string().nullable(),
  }),
  allowedAgents: ['files', 'code', 'research', 'browser', 'computer', 'memory'],
  permissions: ['fs.write'],
  risk: 'medium',
  timeoutMs: 15_000,
  reversible: true,
  idempotent: false,
  verification: 'Relecture du fichier après écriture et comparaison de l’empreinte SHA-256.',
  confirmation: 'Approbation requise pour modifier un fichier existant (overwrite/append).',
  availability: alwaysAvailable,
  resources: (i) => ({ paths: [{ path: i.path, access: 'write' }] }),
  approvalReason: (i) =>
    i.mode !== 'create' && existsSync(i.path) ? `Modification d'un fichier existant (${i.mode})` : null,
  describe: (i) => ({
    description: `Écrire ${i.content.length} caractères dans ${i.path} (mode ${i.mode})`,
    consequences:
      i.mode === 'create'
        ? 'Crée un nouveau fichier.'
        : "Modifie un fichier existant ; l'original est sauvegardé dans le dossier de données HERMES.",
  }),
  async run(i, ctx) {
    const p = assertInsideRoots(i.path, roots(ctx));
    const exists = existsSync(p);
    if (exists && i.mode === 'create') throw new HermesError('COLLISION', `Le fichier existe déjà : ${p}`);
    if (exists && (await lstat(p)).isSymbolicLink())
      throw new HermesError('POLICY_DENIED', 'Écriture via un lien symbolique refusée');
    if (i.createDirs) await mkdir(dirname(p), { recursive: true });
    let backupPath: string | null = null;
    if (exists) {
      backupPath = join(ctx.services.dataDir, 'backups', ctx.missionId, `${Date.now()}-${basename(p)}`);
      await mkdir(dirname(backupPath), { recursive: true });
      await copyFile(p, backupPath);
    }
    if (i.mode === 'append') await appendFile(p, i.content, 'utf8');
    else await writeFile(p, i.content, { encoding: 'utf8', flag: i.mode === 'create' ? 'wx' : 'w' });
    const final = await readFile(p);
    return {
      path: p,
      bytesWritten: Buffer.byteLength(i.content),
      sha256: createHash('sha256').update(final).digest('hex'),
      created: !exists,
      backupPath,
    };
  },
  async verify(i, o) {
    const now = await readFile(o.path);
    const hash = createHash('sha256').update(now).digest('hex');
    const contentOk =
      i.mode === 'append' ? now.toString('utf8').endsWith(i.content) : now.toString('utf8') === i.content;
    return {
      verified: hash === o.sha256 && contentOk,
      detail: contentOk ? 'Contenu relu identique' : 'Le contenu relu diffère',
    };
  },
});

const MovePair = z.object({ from: absPath, to: absPath });

export const filesMove = defineTool({
  id: 'files.move',
  description:
    'Déplace/renomme jusqu’à 100 fichiers dans les dossiers autorisés. Collision: "fail" (défaut, aucun déplacement si une destination existe) ou "rename" (suffixe " (n)"). Jamais d’écrasement.',
  input: z.object({
    moves: z.array(MovePair).min(1).max(100),
    onCollision: z.enum(['fail', 'rename']).default('fail'),
    createDirs: z.boolean().default(true),
  }),
  output: z.object({
    moved: z.array(z.object({ from: z.string(), to: z.string(), size: z.number() })),
    undo: z.array(MovePair),
  }),
  allowedAgents: ['files', 'code'],
  permissions: ['fs.read', 'fs.write'],
  risk: 'medium',
  timeoutMs: 120_000,
  reversible: true,
  idempotent: false,
  verification: 'Pour chaque fichier : destination présente avec la même taille et source absente.',
  confirmation: 'Approbation par défaut (règle modifiable dans Outils et permissions).',
  availability: alwaysAvailable,
  resources: (i) => ({
    paths: i.moves.flatMap((m) => [
      { path: m.from, access: 'write' as const },
      { path: m.to, access: 'write' as const },
    ]),
  }),
  approvalReason: (i) => `Déplacement de ${i.moves.length} fichier(s)`,
  describe: (i) => ({
    description: `Déplacer ${i.moves.length} fichier(s) : ${i.moves
      .slice(0, 5)
      .map((m) => `${basename(m.from)} → ${m.to}`)
      .join(', ')}${i.moves.length > 5 ? '…' : ''}`,
    consequences:
      'Les fichiers changent d’emplacement. Une liste d’annulation est produite ; aucun fichier n’est écrasé.',
  }),
  async run(i, ctx) {
    const r = roots(ctx);
    const plan: { from: string; to: string; size: number }[] = [];
    const taken = new Set<string>();
    const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    for (const m of i.moves) {
      const from = assertInsideRoots(m.from, r);
      let to = assertInsideRoots(m.to, r);
      const s = await lstat(from).catch(() => null);
      if (!s) throw new HermesError('NOT_FOUND', `Source introuvable : ${from}`);
      if (!s.isFile())
        throw new HermesError('VALIDATION', `Seuls les fichiers peuvent être déplacés : ${from}`);
      if (existsSync(to) || taken.has(key(to))) {
        if (i.onCollision === 'fail')
          throw new HermesError('COLLISION', `Destination déjà existante : ${to} (aucun fichier déplacé)`);
        const ext = extname(to);
        const stem = to.slice(0, to.length - ext.length);
        let n = 1;
        while (existsSync(`${stem} (${n})${ext}`) || taken.has(key(`${stem} (${n})${ext}`))) n++;
        to = `${stem} (${n})${ext}`;
      }
      taken.add(key(to));
      plan.push({ from, to, size: s.size });
    }
    const moved: typeof plan = [];
    for (const m of plan) {
      if (ctx.signal.aborted) break;
      if (i.createDirs) await mkdir(dirname(m.to), { recursive: true });
      try {
        await rename(m.from, m.to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        // Cross-volume move: copy, check size, then remove the source.
        await copyFile(m.from, m.to, 1 /* COPYFILE_EXCL */);
        if ((await stat(m.to)).size !== m.size)
          throw new HermesError('TOOL_FAILED', `Copie incomplète : ${m.to}`);
        await unlink(m.from);
      }
      moved.push(m);
    }
    return { moved, undo: moved.map((m) => ({ from: m.to, to: m.from })).reverse() };
  },
  async verify(i, o) {
    const bad: string[] = [];
    for (const m of o.moved) {
      const s = await stat(m.to).catch(() => null);
      if (!s || s.size !== m.size || existsSync(m.from)) bad.push(m.to);
    }
    if (o.moved.length !== i.moves.length) bad.push(`${i.moves.length - o.moved.length} non déplacé(s)`);
    return {
      verified: bad.length === 0,
      detail: bad.length ? `Anomalies : ${bad.join(', ')}` : `${o.moved.length} déplacement(s) confirmé(s)`,
    };
  },
});
