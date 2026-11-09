import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'test-anywhere';
import {
  BUILTIN_CONFIGS,
  buildApiArgs,
  buildDeployArgs,
  classifyApi,
  extractSecret,
  normalizeConfig,
  parseClassicSecret,
  parseMtgSecret,
  redact,
  renderMarkdown,
  scoreResult,
  selectBest,
} from '../src/hive-control-center/scripts/mtproxy/proxy-matrix.mjs';

const config = (overrides = {}) =>
  normalizeConfig({
    id: 'test-config',
    engine: 'classic',
    port: '443',
    workers: '4',
    mss: '1200',
    tests: ['text'],
    ...overrides,
  });

const tempLenv = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtproxy-matrix-test-'));
  const file = join(dir, '.lenv');
  writeFileSync(
    file,
    'SERVER_IP: 203.0.113.10\nSERVER_USER: root\nSERVER_PASS: test\n'
  );
  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const result = (id, overrides = {}) => ({
  config: config({ id, ...overrides.config }),
  deploy: {
    attempted: true,
    ok: true,
    status: 0,
    durationMs: 1000,
    error: '',
    tail: '',
    ...overrides.deploy,
  },
  api: {
    attempted: true,
    status: 'PASS',
    text: true,
    media: false,
    photo: false,
    error: '',
    durationMs: 1000,
    lines: [],
    ...overrides.api,
  },
  score: 1,
  verdict: 'PASS',
});

describe('MTProxy proxy matrix', () => {
  it('builds proxy-only deploy flags for every engine', () => {
    const classic = buildDeployArgs(
      config({ id: 'classic', classicImage: 'mtproxy/mtproxy:latest' })
    );
    expect(classic).toContain('--mtproxy-only');
    expect(classic).toContain('--mtproxy-update');
    expect(classic).toContain('--mtproxy-workers');
    expect(classic).toContain('--mtproxy-classic-image');
    expect(classic.join(' ')).not.toContain('--dangerously-show-secrets');

    const mtg = buildDeployArgs(
      config({ id: 'mtg', engine: 'mtg', frontingHost: 'contabo.com' })
    );
    expect(mtg).toContain('--mtproxy-engine');
    expect(mtg).toContain('--mtproxy-fronting-host');
    expect(buildDeployArgs(config({ id: 'direct', noProxy: true }))).toEqual(
      []
    );
  });

  it('builds API test flags without putting secrets in argv', () => {
    const tmp = tempLenv();
    try {
      const args = buildApiArgs({
        config: config({ id: 'media', tests: ['text', 'media', 'photo'] }),
        lenvFile: tmp.file,
        telegramEnv: '/tmp/telegram.env',
        secretFile: '/tmp/secret',
      });
      expect(args).toContain('--host');
      expect(args).toContain('203.0.113.10');
      expect(args).toContain('--secret-file');
      expect(args).toContain('/tmp/secret');
      expect(args).toContain('--media');
      expect(args).toContain('--roundtrip-photo');
      expect(args).toContain('--relax-ping');
      expect(args.join(' ')).not.toContain('0123456789abcdef');
    } finally {
      tmp.cleanup();
    }
  });

  it('parses classic and FakeTLS secrets', () => {
    const key = '0123456789abcdef0123456789abcdef';
    expect(parseClassicSecret(`${key}\n`)).toBe(key);
    expect(parseClassicSecret(`dd${key}\n`)).toBe(key);
    expect(parseClassicSecret('nope')).toBe('');
    expect(extractSecret('classic', `dd${key}`)).toBe(key);
    expect(
      parseMtgSecret(
        `tg://proxy?server=x&port=443&secret=ee${key}636f6e7461626f2e636f6d`
      )
    ).toBe(`ee${key}636f6e7461626f2e636f6d`);
    expect(parseMtgSecret('no secret here')).toBe('');
  });

  it('classifies API output into text/media/photo results', () => {
    const output = [
      'API_TEST_SENT=yes saved_messages_verified=yes marker=x',
      'API_TEST_MEDIA_DOWNLOADED=yes bytes=10 verified=yes',
      'API_TEST_PHOTO_DOWNLOADED=yes bytes=10 verified=yes',
      'API_TEST_STATUS=PASS',
    ].join('\n');
    expect(classifyApi(output)).toEqual({
      status: 'PASS',
      text: true,
      media: true,
      photo: true,
      sent: true,
      error: '',
    });
    expect(
      classifyApi('API_TEST_ERROR=Ping timeout\nAPI_TEST_STATUS=FAIL')
    ).toEqual({
      status: 'FAIL',
      text: false,
      media: false,
      photo: false,
      sent: false,
      error: 'Ping timeout',
    });
  });

  it('selects the best passed configuration and ignores direct control', () => {
    const text = result('text-only', { config: { tests: ['text'] } });
    text.score = scoreResult(text);
    const media = result('media', { config: { tests: ['text', 'media'] } });
    media.api.media = true;
    media.score = scoreResult(media);
    const direct = result('direct', { config: { noProxy: true } });
    direct.score = scoreResult(direct);
    direct.api.text = true;
    expect(selectBest([text, media, direct])?.config.id).toBe('media');
    expect(selectBest([direct])).toBeNull();
  });

  it('renders a summary without secrets and marks unrequested tests', () => {
    const summary = {
      startedAt: '2026-11-09T00:00:00.000Z',
      network: {
        publicIp: '203.0.113.10',
        interface: 'en0',
        gateway: '203.0.113.1',
      },
      preflight: { ok: true, error: '' },
      selected: {
        id: 'classic-baseline',
        reason: 'best score 6',
        detail: 'Kept.',
      },
      results: [
        {
          ...result('classic-baseline', {
            config: { tests: ['text', 'media'] },
          }),
          config: config({ id: 'classic-baseline', tests: ['text', 'media'] }),
        },
      ],
    };
    const markdown = renderMarkdown(summary);
    expect(markdown).toContain('classic-baseline');
    expect(markdown).toContain('Kept.');
    expect(markdown).toContain('| PASS |');
    expect(markdown).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('redacts secret-like values', () => {
    expect(
      redact('tg://proxy?secret=ee0123456789abcdef0123456789abcdef&x=1')
    ).not.toContain('ee0123456789abcdef0123456789abcdef');
    expect(redact('0123456789abcdef0123456789abcdef')).toBe('[redacted]');
  });

  it('validates built-in configuration bounds', () => {
    expect(BUILTIN_CONFIGS.length).toBeGreaterThan(5);
    expect(() => normalizeConfig({ id: 'Bad Id' })).toThrow();
    expect(() => normalizeConfig({ id: 'bad', workers: '7' })).toThrow();
    expect(() => normalizeConfig({ id: 'bad', tests: ['video'] })).toThrow();
  });
});
