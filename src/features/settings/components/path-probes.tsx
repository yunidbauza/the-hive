import type { PathProbe } from '@shared/config-contract';

/**
 * Where a command was looked for, and what was found (stories 104, 106).
 *
 * Extracted from `command-diagnostic-view` when story 106 needed to explain a
 * missing `gh` the same way story 104 explains a missing agent command. Two
 * copies would have drifted, and the drift would show up as two screens
 * describing the same `PATH` differently.
 */
export function PathProbes({ probes }: { probes: readonly PathProbe[] }) {
  if (probes.length === 0) return null;

  return (
    <ul className="flex flex-col gap-0.5">
      {probes.map((probe) => (
        <li
          key={probe.directory}
          className="flex items-center gap-2 font-mono text-[11px]"
        >
          <span
            aria-hidden
            className={
              probe.found
                ? 'text-green'
                : probe.notExecutable
                  ? 'text-amber'
                  : 'text-subtle'
            }
          >
            {probe.found ? '✓' : probe.notExecutable ? '!' : '·'}
          </span>
          <span className={probe.found ? 'text-ink' : 'text-subtle'}>
            {probe.directory}
          </span>
          {/* The genuinely confusing case: the file is right there, and the
              only reason it does not run is a missing +x bit. */}
          {probe.notExecutable ? (
            <span className="text-amber">present, not executable</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
