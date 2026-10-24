import { z } from 'zod';
import { browserClick, browserExtract, browserFill, browserNavigate } from './browser';
import { desktopClick, desktopInspect, desktopKeypress, desktopType, screenObserve } from './desktop';
import { filesMove, filesRead, filesSearch, filesWrite } from './files';
import { memorySave, memorySearch, missionCancel, missionPause, missionVerify } from './mission';
import { processRun } from './process';
import { webSearch } from './web-search';
import type { AnyTool } from './types';
import type { ChatToolSpec } from '../model-providers/types';

export const ALL_TOOLS: readonly AnyTool[] = [
  screenObserve,
  desktopInspect,
  desktopClick,
  desktopType,
  desktopKeypress,
  browserNavigate,
  browserExtract,
  browserClick,
  browserFill,
  filesSearch,
  filesRead,
  filesMove,
  filesWrite,
  processRun,
  webSearch,
  memorySearch,
  memorySave,
  missionPause,
  missionCancel,
  missionVerify,
];

export function createToolRegistry(tools: readonly AnyTool[] = ALL_TOOLS): ReadonlyMap<string, AnyTool> {
  const map = new Map<string, AnyTool>();
  for (const t of tools) {
    if (map.has(t.id)) throw new Error(`Outil dupliqué : ${t.id}`);
    map.set(t.id, t);
  }
  return map;
}

/** Function names exposed to models must match ^[a-zA-Z0-9_-]{1,64}$, so dots are encoded. */
export const toFunctionName = (toolId: string): string => toolId.replace(/\./g, '__');
export const fromFunctionName = (name: string): string => name.replace(/__/g, '.');

export function toChatToolSpec(tool: AnyTool): ChatToolSpec {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return {
    type: 'function',
    function: { name: toFunctionName(tool.id), description: tool.description, parameters: schema },
  };
}
