import { describe, expect, it } from 'vitest';

import {
  ENV_PLACEHOLDER,
  expandEnvArgs,
  substituteEnv,
} from '../../../../electron/main/sessions/container-command';

describe('expandEnvArgs', () => {
  it('expands one argument per variable, in insertion order', () => {
    expect(
      expandEnvArgs({ FOO: 'bar', BAZ: 'qux' }, '-e {name}={value}'),
    ).toBe("-e FOO='bar' -e BAZ='qux'");
  });

  it('quotes the value so spaces and quotes cannot split the argument', () => {
    expect(expandEnvArgs({ FOO: "a b'c" }, '-e {name}={value}')).toBe(
      "-e FOO='a b'\\''c'",
    );
  });

  it('leaves the template text verbatim, so any runtime can spell it', () => {
    expect(expandEnvArgs({ FOO: 'bar' }, '--env {name} --value {value}')).toBe(
      "--env FOO --value 'bar'",
    );
  });

  it('is empty for an empty environment', () => {
    expect(expandEnvArgs({}, '-e {name}={value}')).toBe('');
  });
});

describe('substituteEnv', () => {
  it('puts the arguments where the placeholder is', () => {
    expect(
      substituteEnv('docker exec -it {env} devbox claude', "-e FOO='bar'"),
    ).toBe("docker exec -it -e FOO='bar' devbox claude");
  });

  it('returns null when the command has no placeholder', () => {
    expect(substituteEnv('docker exec -it devbox claude', "-e FOO='bar'")).toBe(
      null,
    );
  });

  it('leaves no double space when there is nothing to expand', () => {
    expect(substituteEnv('docker exec -it {env} devbox claude', '')).toBe(
      'docker exec -it devbox claude',
    );
  });

  it('repeats the expansion at every placeholder, visibly', () => {
    expect(substituteEnv('run {env} then {env}', '-e A=1')).toBe(
      'run -e A=1 then -e A=1',
    );
  });

  it('exports the placeholder it looks for', () => {
    expect(ENV_PLACEHOLDER).toBe('{env}');
  });
});
