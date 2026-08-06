'use strict';
// ============================================================
// ★ダイコメの「使える人」を、社長が決められること★ 2026-08-06
//
//   ★司さんの指示★
//     「打たせてええけん複雑にするな」
//     「それをするならダイコメの管理アプリを（Exally系の）ように作って
//       そこでおれが権限持つようしろ」
//     「ダイコメ用の作れや 最終は別アプリやろが」
//
//   ★決めた形★
//     ・Exally の表(exally_entitlements)には★載せない★
//       ＝ダイコメ自身の部屋(daikome.dk_members)に持つ。独立する時そのまま持って出られる。
//     ・今までは★会社を作った人1人しか事務所に入れなかった★（全棚 owner_id = auth.uid()）
//     ・社長が メールで足す／外す。外したらその場で入れない。
//     ・★社長は自分を外せない★（誰も入れなくなるのを防ぐ）
//     ・ログインは今までどおり メール＋合言葉（増やさない）
//
//   ★倉庫の側で実際に確かめた（テストDB・2026-08-06）★
//     ① 足していない人は 会社が0件に見える      → 入れない
//     ② 社長が足すと 201
//     ③ 足した人には一覧が見える
//     ④ 従業員が人を足そうとすると ★403★
//     ⑤ 社長が自分を外そうとすると ★400★
//     ⑥ 外した瞬間に 見える物が0件になる
// ============================================================
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'apply-dk-members.sql'), 'utf8');

describe('★ダイコメ自身の部屋に持つこと（Exallyに寄りかからない）★', () => {
  it('棚は daikome の中に作る', () => {
    expect(SQL).toContain('create table if not exists daikome.dk_members');
  });

  it('★Exally の表を使っていない★（最後は別アプリになるため）', () => {
    // 説明の文に名前が出るのは良い。★実際に読み書きしていないこと★を見る。
    const code = SQL.split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code, '★Exallyに寄りかかると独立できない★').not.toMatch(
      /(from|join|into|update|table)\s+exally\./i
    );
    expect(HTML, '★Exallyの表を読んでいる★').not.toContain('exally_entitlements');
  });

  it('public にも同じ名前の窓口を出す（アプリのコードは今までどおり）', () => {
    expect(SQL).toContain('create or replace view public.dk_members');
    expect(SQL, '窓口が本人の権限で動いていない').toContain('security_invoker = true');
  });
});

describe('★社長だけが 足す・外す できること★', () => {
  it('足す/外すの鍵は「社長かどうか」で縛る', () => {
    expect(SQL).toMatch(
      /create policy dk_members_write[\s\S]{0,200}daikome\.is_owner\(company_id\)/
    );
  });

  it('読むのは「その会社を使える人」だけ', () => {
    expect(SQL).toMatch(/create policy dk_members_read[\s\S]{0,160}my_companies\(\)/);
  });

  it('★社長は自分を外せない★', () => {
    expect(SQL).toContain('会社の持ち主は外せません');
    expect(SQL, '外す時だけでなく「使えない」に変える時も止める').toMatch(
      /tg_op = 'UPDATE'[\s\S]{0,120}new\.active = false/
    );
  });

  it('★会社ごと消す時は通す★（持ち主の行が盾になって会社を消せなくなるため）', () => {
    expect(SQL, '★これが無いと会社を1つも消せない（実際に詰まった）★').toMatch(
      /not exists \(select 1 from daikome\.dk_companies/
    );
  });

  it('★今 入っている人（会社を作った人）を必ず入れる★（切り替えた瞬間に締め出さない）', () => {
    expect(SQL).toMatch(/insert into daikome\.dk_members[\s\S]{0,200}'owner'/);
  });
});

describe('★画面がそろっていること★', () => {
  it('「使える人」の箱がある', () => {
    expect(HTML).toContain('id="memberCard"');
    expect(HTML).toContain('この事務所を使える人');
  });

  it('メールで足せる', () => {
    expect(HTML).toContain('id="memberMail"');
    expect(HTML).toContain('id="memberAdd"');
    expect(HTML).toContain('bindMemberAdd()');
  });

  it('★打ち間違いをその場で止める★（.cpm のような1文字違いで別の空部屋に行った事故があった）', () => {
    expect(HTML, '★メールの形を確かめずに足している★').toMatch(
      /\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[a-z\]\{2,\}\$/
    );
  });

  it('★社長でなければ箱ごと出さない★（触れない物を見せない）', () => {
    expect(HTML, '社長かどうかを見ていない').toContain('var iAmOwner');
    expect(HTML, '★社長でなくても箱が出る★').toMatch(
      /card\.style\.display = iAmOwner \? '' : 'none'/
    );
    expect(HTML, '社長でない時に中身を描いてしまう').toContain('if (!iAmOwner) return;');
  });

  it('★社長の行には「外す」を出さない★', () => {
    expect(HTML).toMatch(/if \(!isOwner\) \{[\s\S]{0,200}rm/);
  });

  it('会社の設定を開いたら 使える人も描く', () => {
    expect(HTML, '★描いていない＝開いても出ない★').toMatch(/renderMembers\(\); \/\/ ★使える人/);
  });

  it('外す時は確かめてから（押し間違いで締め出さない）', () => {
    expect(HTML).toMatch(/confirm\([\s\S]{0,80}外しますか/);
  });

  it('★ログインのやり方は増やしていない★（司さん「複雑にするな」）', () => {
    // 合言葉つきのメールログインのまま。魔法のリンクや二段階を足していない。
    expect(HTML).not.toMatch(/signInWithOtp|magiclink|otp|二段階/i);
  });
});
