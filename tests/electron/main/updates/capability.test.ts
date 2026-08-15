// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/Applications/The Hive.app/Contents/MacOS/The Hive' },
}));

const { probeUpdateCapability, demoteToManual } = await import(
  '../../../../electron/main/updates/capability'
);

const base = {
  packaged: true,
  platform: 'darwin' as NodeJS.Platform,
  bundlePath: '/Applications/The Hive.app',
};

/** What `codesign --display --verbose=2` prints for a Developer ID build. */
const DEVELOPER_ID = `Executable=/Applications/The Hive.app/Contents/MacOS/The Hive
Identifier=com.behiques.the-hive
Format=app bundle with Mach-O thin (arm64)
Authority=Developer ID Application: Someone (TEAMID)
Authority=Developer ID Certification Authority`;

/** …and for an ad-hoc one, which is what this project actually ships. */
const ADHOC = `Executable=/Applications/The Hive.app/Contents/MacOS/The Hive
Identifier=com.behiques.the-hive
Format=app bundle with Mach-O thin (arm64)
Signature=adhoc
Info.plist entries=32`;

describe('probeUpdateCapability', () => {
  it('refuses to check at all in a development run', async () => {
    const capability = await probeUpdateCapability({
      ...base,
      packaged: false,
      codesign: vi.fn(),
    });

    expect(capability).toMatchObject({ canCheck: false, mode: 'manual' });
    expect(capability.reason).toContain('development run');
  });

  it('reads a Developer ID as a verified self-install', async () => {
    const capability = await probeUpdateCapability({
      ...base,
      codesign: vi.fn().mockResolvedValue(DEVELOPER_ID),
    });

    expect(capability).toMatchObject({ canCheck: true, mode: 'self-install' });
  });

  it('sends an ad-hoc build straight down the manual path', async () => {
    /**
     * Measured, not assumed. 0.1.0 and 0.1.1 were published and the packaged
     * 0.1.0 was driven through the whole flow: the download succeeded, the app
     * reported the update ready, and the swap failed with
     * `SQRLCodeSignatureErrorDomain` — "code failed to satisfy specified code
     * requirement(s)". An ad-hoc bundle's designated requirement is its own
     * cdhash, so no successor can ever satisfy it.
     *
     * Attempting anyway would cost a 130MB download and a false promise of a
     * restart, every session, forever.
     */
    const capability = await probeUpdateCapability({
      ...base,
      codesign: vi.fn().mockResolvedValue(ADHOC),
    });

    expect(capability).toMatchObject({ canCheck: true, mode: 'manual' });
    expect(capability.reason).toContain('ad-hoc signed');
  });

  it('falls back to manual for an unsigned bundle', async () => {
    const capability = await probeUpdateCapability({
      ...base,
      codesign: vi.fn().mockResolvedValue('Executable=/x\ncode object is not signed at all'),
    });

    expect(capability).toMatchObject({ mode: 'manual', canCheck: true });
  });

  it('treats a missing or failing codesign as manual, not as an error', async () => {
    // No Command Line Tools installed is a perfectly ordinary machine, and it
    // must not turn into an error dialog on launch.
    const capability = await probeUpdateCapability({
      ...base,
      codesign: vi.fn().mockRejectedValue(new Error('spawn codesign ENOENT')),
    });

    expect(capability).toMatchObject({ mode: 'manual', canCheck: true });
    expect(capability.reason).toContain('ENOENT');
  });

  it('never reads a signature off a non-mac build', async () => {
    const codesign = vi.fn();
    const capability = await probeUpdateCapability({
      ...base,
      platform: 'win32',
      codesign,
    });

    expect(codesign).not.toHaveBeenCalled();
    expect(capability).toMatchObject({ mode: 'self-install' });
  });
});

describe('demoteToManual', () => {
  it('turns a self-install build into a manual one, naming what macOS said', async () => {
    // The runtime safety net for a build the probe cleared — the swap can still
    // be refused, and the refusal arrives asynchronously long after the
    // download claimed success.
    const before = await probeUpdateCapability({
      ...base,
      codesign: vi.fn().mockResolvedValue(DEVELOPER_ID),
    });
    const after = demoteToManual(before, 'code signature not valid');

    expect(before.mode).toBe('self-install');
    expect(after.mode).toBe('manual');
    expect(after.reason).toContain('code signature not valid');
  });
});
