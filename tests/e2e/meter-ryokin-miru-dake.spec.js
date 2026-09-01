// tests/e2e/meter-ryokin-miru-dake.spec.js
// ★★メーターの 料金設定は「見るだけ」★★ 2026-09-01
//
//   ★司さん（2026-09-01）★
//     「てかなんでメーターの設定からまだ料金触れるんど 事務所からだけにしたんやないんか」
//
//   ★何を したか★
//     ・料金表(倉庫)の 中身を ★全部 事務所で 直せるように した★
//       （基本／段階／割増（手で押す）／自動の割増／車種／待ち時間／下限上限）
//     ・その上で メーター側を ★見るだけ★に した
//   ★消していません★… 見た目は そのまま・触れないだけ。事務所が 使えない 時に 戻せます。
//   ★追加料金・値引きは ここでは 見ません★＝料金表では なく ★端末ごとの localStorage★
//
//   ★ここで 見る事★
//     ①「見るだけ」と 書いてある（人が 分かる）
//     ②★入れる所が 1つも 押せない★（実ブラウザで 押してみる）
//     ③★保存の ボタンが 出ていない★（★出来ない事の ボタンを 見せない★）
//     ④★数字は 見える★（今の 料金表が 分かる＝ただ 隠すのとは 違う）
//     ⑤★追加料金・値引きは 今まで通り 触れる★（料金表では ないので 止めない）
//
//   ★★わざと壊して 実測（2026-09-01）★★
//     pointer-events の 行を 消す → ★②が 赤★／btn-save の display:none を 消す → ★③が 赤★
//     帯を 消す → ★①が 赤★／戻して 4本 緑
const { test, expect } = require('@playwright/test');

// ★見るのは ★料金表の 札★だけ★（追加料金・値引きは 端末の 物なので 触れて よい）
async function hiraku(page) {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.showOverlay('fare'));
  await page.waitForTimeout(400);
  // ★基本の 札を 開く★（既定は「追加料金」なので 料金表の 数字が 出ない）
  await page.evaluate(() => {
    const b = document.querySelector('#overlayFare .tab-btn');
    document
      .querySelectorAll('#overlayFare .tab-pane')
      .forEach((p) => p.classList.remove('active'));
    const kihon = document.querySelector('#overlayFare .tab-pane[data-pane="basic"]');
    if (kihon) kihon.classList.add('active');
    if (b) b.classList.add('active');
  });
  await page.waitForTimeout(200);
}

test('★① 「見るだけ」と 書いてある★', async ({ page }) => {
  await hiraku(page);
  const t = await page.textContent('#overlayFare .miru-dake-obi');
  expect(t, '★「見るだけ」の 断りが ありません★').toContain('見るだけ');
  expect(t, '★どこで 変えるか 書いていません★').toContain('事務所');
});

test('★★② 入れる所が 1つも 押せない★★', async ({ page }) => {
  await hiraku(page);
  const r = await page.evaluate(() => {
    const li = Array.prototype.slice.call(
      document.querySelectorAll(
        "#overlayFare .tab-pane:not([data-pane='extras']):not([data-pane='discounts']) input"
      )
    );
    const sawareru = li.filter((e) => {
      const b = e.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return false; // 出ていない物は 数えない
      return getComputedStyle(e).pointerEvents !== 'none';
    });
    return { zenbu: li.length, sawareru: sawareru.length };
  });
  expect(r.zenbu, '★入れる所が 1つも 見つかりません（数え方が 壊れています）★').toBeGreaterThan(3);
  expect(r.sawareru, '★まだ 触れる 所が あります（メーターから 料金を 変えられます）★').toBe(0);
});

test('★★③ 保存の ボタンが 出ていない★★', async ({ page }) => {
  await hiraku(page);
  const mieru = await page.evaluate(() => {
    const e = document.querySelector('#overlayFare .btn-save');
    if (!e) return false;
    const b = e.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && getComputedStyle(e).display !== 'none';
  });
  expect(mieru, '★保存の ボタンが 出ています（押しても 意味が ありません）★').toBe(false);
});

test('★④ 数字は 見える（ただ 隠すのとは 違う）★', async ({ page }) => {
  await hiraku(page);
  const kazu = await page.evaluate(() => {
    const li = Array.prototype.slice.call(
      document.querySelectorAll("#overlayFare .tab-pane[data-pane='basic'] input")
    );
    return li.filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && String(e.value || '').trim() !== '';
    }).length;
  });
  expect(kazu, '★今の 料金表の 数字が 1つも 見えません★').toBeGreaterThan(2);
});

test('★★⑤ 追加料金・値引きは 今まで通り 触れる（止めすぎない）★★', async ({ page }) => {
  await hiraku(page);
  // ★追加料金の 札には 入れる所が 元から 無い★（押すと 増える 作り）ので ★押す物★を 見る
  //   ★その札を 開いてから 測る★（開いていない 札は 大きさ0で 出ます）
  await page.evaluate(() => {
    document
      .querySelectorAll('#overlayFare .tab-pane')
      .forEach((p) => p.classList.remove('active'));
    const e = document.querySelector("#overlayFare .tab-pane[data-pane='extras']");
    if (e) e.classList.add('active');
  });
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => {
    const b = document.querySelector("#overlayFare .tab-pane[data-pane='extras'] .btn-add");
    if (!b) return { aru: false };
    const box = b.getBoundingClientRect();
    return {
      aru: true,
      mieru: box.width > 0 && box.height > 0 && getComputedStyle(b).display !== 'none',
      oseru: getComputedStyle(b).pointerEvents !== 'none',
    };
  });
  expect(r.aru, '★追加料金の「足す」ボタンが 見つかりません★').toBe(true);
  expect(r.mieru, '★料金表では ない物まで 隠しています（機能を 減らしています）★').toBe(true);
  expect(r.oseru, '★料金表では ない物まで 止めています★').toBe(true);
});
