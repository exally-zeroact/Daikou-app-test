'use strict';
// ============================================================
// dk-session 共通土台 テスト (2026-08-01)
//
//   ★何のための部品か★
//   ダイコメの会社向け画面（管理画面 / 売上表 / 給料明細 / 月次集計）を
//   **同じログイン・同じ session の扱い**で作るための土台。
//   これを共通化しておかないと、最後に管理画面へまとめる時に全部書き直しになる。
//
//   ★ダイコメのログインはマジックリンク★（メール+パスワードの exally-login.js とは別物）。
//   混ぜると同じ人が別扱いになるので、ここに寄せる。
//
//   ★守る性質★
//     1. 何が来ても throw しない（画面が真っ白にならない）
//     2. 期限切れ / 期限間近を正しく判定する（切れたまま使わない）
//     3. 壊れた保存値でログイン状態を偽らない
// ============================================================
const DKSession = require('../../js/dk-session.js');

describe('マジックリンクの戻り（URLの#）から session を取り出す', () => {
  it('access_token と refresh_token を取り出す', () => {
    const s = DKSession.parseHash(
      '#access_token=AAA&refresh_token=BBB&expires_in=3600&token_type=bearer'
    );
    expect(s.access_token).toBe('AAA');
    expect(s.refresh_token).toBe('BBB');
    expect(s.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('expires_at が入っていればそれを使う', () => {
    const s = DKSession.parseHash('#access_token=AAA&expires_at=2000000000');
    expect(s.expires_at).toBe(2000000000);
  });

  it('access_token が無ければ null（ログインしたことにしない）', () => {
    expect(DKSession.parseHash('#refresh_token=BBB')).toBeNull();
    expect(DKSession.parseHash('')).toBeNull();
    expect(DKSession.parseHash('#')).toBeNull();
  });

  it('★何が来ても throw しない★', () => {
    expect(() => DKSession.parseHash(null)).not.toThrow();
    expect(() => DKSession.parseHash(undefined)).not.toThrow();
    expect(() => DKSession.parseHash({})).not.toThrow();
    expect(DKSession.parseHash(null)).toBeNull();
  });
});

describe('期限の判定', () => {
  const now = 1000000;

  it('期限が先ならまだ使える', () => {
    expect(DKSession.needsRefresh({ access_token: 'a', expires_at: now + 3600 }, now)).toBe(false);
  });

  it('期限切れは要更新', () => {
    expect(DKSession.needsRefresh({ access_token: 'a', expires_at: now - 1 }, now)).toBe(true);
  });

  it('★期限の直前も要更新（画面を開いた直後に切れるのを防ぐ）★', () => {
    expect(DKSession.needsRefresh({ access_token: 'a', expires_at: now + 30 }, now)).toBe(true);
  });

  it('壊れた値は「使えない」と判定する（ログイン状態を偽らない）', () => {
    expect(DKSession.needsRefresh(null, now)).toBe(true);
    expect(DKSession.needsRefresh({}, now)).toBe(true);
    expect(DKSession.needsRefresh({ access_token: '' }, now)).toBe(true);
    expect(DKSession.needsRefresh({ access_token: 'a' }, now)).toBe(true); // 期限不明
  });

  it('★何が来ても throw しない★', () => {
    expect(() => DKSession.needsRefresh('x', now)).not.toThrow();
    expect(() => DKSession.needsRefresh(undefined, undefined)).not.toThrow();
  });
});

describe('保存と読み出し', () => {
  it('保存した session を読み出せる', () => {
    const store = {};
    const ls = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
    };
    DKSession._setStore(ls);
    DKSession.save({ access_token: 'A', refresh_token: 'B', expires_at: 123 });
    expect(DKSession.load()).toEqual({ access_token: 'A', refresh_token: 'B', expires_at: 123 });
    DKSession.clear();
    expect(DKSession.load()).toBeNull();
    DKSession._setStore(null);
  });

  it('壊れた保存値なら null（ログイン状態を偽らない）', () => {
    const ls = {
      getItem: () => '{{{ not json',
      setItem: () => {},
      removeItem: () => {},
    };
    DKSession._setStore(ls);
    expect(DKSession.load()).toBeNull();
    DKSession._setStore(null);
  });

  it('★保存できない環境でも throw しない★', () => {
    const ls = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    DKSession._setStore(ls);
    expect(() => DKSession.save({ access_token: 'A' })).not.toThrow();
    expect(() => DKSession.load()).not.toThrow();
    expect(() => DKSession.clear()).not.toThrow();
    expect(DKSession.load()).toBeNull();
    DKSession._setStore(null);
  });

  it('★管理画面と同じ保存キーを使う（同じログインを共有する）★', () => {
    expect(DKSession.KEY).toBe('dk_dash_sess');
  });
});
