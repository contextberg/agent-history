import React from 'react';
import type { AgentSource } from '../types';
import { useTheme } from '../hooks/useTheme';

const ICON_SOURCES = new Set<AgentSource>(['claude-code', 'cursor', 'codex', 'copilot', 'hermes', 'openclaw']);

// SVGs using currentColor (black by default) → need invert in dark mode
const MONO_SOURCES = new Set<AgentSource>(['cursor', 'copilot', 'hermes']);

function iconPath(source: AgentSource): string {
  return `/icons/${source}.svg`;
}

interface Props {
  source: AgentSource;
  size?: number;
}

export function SourceIcon({ source, size = 14 }: Props) {
  const { theme } = useTheme();
  const mono = MONO_SOURCES.has(source);
  const filter = mono && theme === 'dark' ? 'invert(1) brightness(0.9)' : undefined;

  return (
    <img
      src={iconPath(source)}
      alt={source}
      width={size}
      height={size}
      style={{ flexShrink: 0, display: 'inline-block', filter }}
      draggable={false}
    />
  );
}
