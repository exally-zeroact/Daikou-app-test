/* ============================================================
 * js/daikome-admin.js
 * ★ダイコメ 管理画面（運営＝司さん専用）★ 2026-08-07
 *
 *   司さん「ダイコメの管理アプリを（Exally系の）ように作って
 *           そこでおれが権限持つようしろ」
 *
 *   ★他のアプリ（Kyually admin.html / Castally castally-admin.html）と同じ形★
 *     ログイン → 管理者か判定 → 一覧 → 押して切り替え。それだけ。
 *
 *   ★ダイコメで押す物★
 *     プランではなく ★使う / 止める★ と ★席数★。
 *     dk_companies.status / seat_limit は元からある。新しい仕組みは足していない。
 *
 *   ▼守ること
 *     ・鍵の本体は倉庫側(RLS)。この画面は見せ方だけ＝サービス鍵は絶対に置かない
 *     ・押した瞬間に画面を先に変え、失敗したら戻す（待たせない）
 *     ・数字を勝手に丸めない・件数は必ず出す
 * ============================================================ */
(function () {
  'use strict';

  const cfg = window.DKConfig;
  const sb = window.supabase.createClient(cfg.SB_URL, cfg.ANON_KEY);
  const $ = function (id) {
    return document.getElementById(id);
  };

  let rows = []; // 会社ぜんぶ
  let curEmail = '';

  function show(id) {
    ['login', 'denied', 'panel'].forEach(function (x) {
      $(x).classList.toggle('hide', x !== id);
    });
    $('topbar').classList.toggle('hide', id === 'login');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  let toastT = null;
  function toast(m) {
    const t = $('toast');
    t.textContent = m;
    t.classList.add('show');
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(function () {
      t.classList.remove('show');
    }, 1800);
  }
  function ymd(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (isNaN(d)) return '—';
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  // ── ログイン ──
  $('signin').onclick = function () {
    const e = $('email').value.trim();
    const p = $('pw').value;
    if (!e || !p) {
      $('msg').textContent = 'メールとパスワードを入れてください';
      return;
    }
    $('msg').textContent = 'ログイン中…';
    sb.auth.signInWithPassword({ email: e, password: p }).then(function (r) {
      if (r.error) {
        $('msg').textContent = /Invalid/.test(r.error.message)
          ? 'メールかパスワードが違います'
          : r.error.message;
      } else {
        $('msg').textContent = '';
        boot();
      }
    });
  };
  $('pw').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') $('signin').click();
  });
  $('logout').onclick = function () {
    sb.auth.signOut().then(function () {
      location.reload();
    });
  };
  $('refresh').onclick = function () {
    loadList();
  };
  $('q').addEventListener('input', render);

  // ── 起動: ログインを見る → ★ダイコメの運営か判定★ ──
  function boot() {
    sb.auth.getUser().then(function (r) {
      const u = r.data && r.data.user;
      if (!u) {
        show('login');
        return;
      }
      curEmail = u.email || '';
      $('who').textContent = curEmail;
      // ★ダイコメ自身の dk_admins を見る（Exally の表には寄りかからない）★
      sb.from('dk_admins')
        .select('account_id')
        .eq('account_id', u.id)
        .maybeSingle()
        .then(function (a) {
          if (a.data) {
            show('panel');
            loadList();
          } else {
            show('denied');
          }
        });
    });
  }

  // ── 一覧を取る ──
  function loadList() {
    $('stat').textContent = '読み込み中…';
    Promise.all([
      sb
        .from('dk_companies')
        .select('company_id,name,status,seat_limit,plan,contact,owner_id,created_at'),
      sb.from('dk_company_devices').select('company_id,device_id'),
      sb.from('dk_shifts').select('company_id,started_at'),
    ]).then(function (res) {
      const cos = (res[0] && res[0].data) || [];
      const devs = (res[1] && res[1].data) || [];
      const shifts = (res[2] && res[2].data) || [];

      const devN = {};
      devs.forEach(function (d) {
        if (!d) return;
        devN[d.company_id] = (devN[d.company_id] || 0) + 1;
      });
      const last = {};
      shifts.forEach(function (s) {
        if (!s || !s.started_at) return;
        if (!last[s.company_id] || s.started_at > last[s.company_id])
          last[s.company_id] = s.started_at;
      });

      rows = cos.map(function (c) {
        return {
          id: c.company_id,
          name: c.name || '(名前なし)',
          status: c.status === 'off' ? 'off' : 'on',
          seat: Number(c.seat_limit) || 0,
          contact: c.contact || '',
          created: c.created_at,
          devices: devN[c.company_id] || 0,
          last: last[c.company_id] || null,
        };
      });
      rows.sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name), 'ja');
      });
      render();
    });
  }

  // ── 出す ──
  function render() {
    const q = String($('q').value || '')
      .trim()
      .toLowerCase();
    const list = rows.filter(function (r) {
      if (!q) return true;
      return (r.name + ' ' + r.contact).toLowerCase().indexOf(q) >= 0;
    });

    const off = rows.filter(function (r) {
      return r.status === 'off';
    }).length;
    $('stat').textContent =
      '全部で ' +
      rows.length +
      ' 社（止めている会社 ' +
      off +
      '）' +
      (q ? ' … しぼり込み ' + list.length + ' 社' : '');

    if (!list.length) {
      $('list').innerHTML = '<div class="card empty">ありません</div>';
      return;
    }

    $('list').innerHTML = list
      .map(function (r) {
        return (
          '<div class="co" data-id="' +
          esc(r.id) +
          '">' +
          '<div class="co-name">' +
          esc(r.name) +
          '</div>' +
          '<div class="co-sub">' +
          esc(r.contact || '(連絡先なし)') +
          '</div>' +
          '<div class="co-sub">はじめ ' +
          ymd(r.created) +
          '　最後に走った日 ' +
          ymd(r.last) +
          '　使っている車 ' +
          r.devices +
          '台</div>' +
          '<div class="co-row">' +
          '<div class="seg">' +
          '<button class="pill' +
          (r.status === 'on' ? ' on' : '') +
          '" data-act="on">使う</button>' +
          '<button class="pill off' +
          (r.status === 'off' ? ' on' : '') +
          '" data-act="off">止める</button>' +
          '</div>' +
          '<div class="seat">席数 <input type="number" inputmode="numeric" min="0" value="' +
          r.seat +
          '" data-act="seat"> 台</div>' +
          '</div></div>'
        );
      })
      .join('');

    Array.prototype.forEach.call($('list').querySelectorAll('[data-act]'), function (el) {
      const box = el.closest('.co');
      const id = box.getAttribute('data-id');
      const act = el.getAttribute('data-act');
      if (act === 'seat') {
        el.onchange = function () {
          setSeat(id, Math.max(0, parseInt(el.value, 10) || 0), el);
        };
      } else {
        el.onclick = function () {
          setStatus(id, act);
        };
      }
    });
  }

  // ── ★新しいお客さん（会社）を登録する★ 2026-08-07 ──
  //   司さん「おれが新規で登録してやるんやろが」
  //   今まではお客さん自身が事務所から登録する形しか無かった。
  //   ここで登録して、★その会社に渡す会社URL★を出す。
  //   ・url_token は毎回ちがう物を作る（人が推せない長さ）
  //   ・持ち主(owner_id)は空のまま。お客さんが自分で事務所に登録した時に埋まる。
  //     ★運転手はQRで有効化するだけなので、持ち主が空でもメーターは今日から使える。★
  function newToken() {
    const b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    let s = '';
    for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }

  $('newAdd').onclick = function () {
    const name = String($('newName').value || '').trim();
    const contact = String($('newContact').value || '').trim();
    const seat = Math.max(1, parseInt($('newSeat').value, 10) || 1);
    if (!name) {
      $('newMsg').textContent = '会社名を入れてください';
      return;
    }
    // ★打ち間違いをその場で止める★（空は許す＝あとで入れられる）
    if (contact && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(contact)) {
      $('newMsg').textContent = 'メールアドレスを確かめてください';
      return;
    }
    $('newMsg').textContent = '';
    $('newAdd').disabled = true;
    const token = newToken();
    sb.from('dk_companies')
      .insert({
        name: name,
        url_token: token,
        status: 'on',
        seat_limit: seat,
        contact: contact,
      })
      .select('company_id,url_token')
      .then(function (res) {
        $('newAdd').disabled = false;
        if (res.error || !res.data || !res.data.length) {
          $('newMsg').textContent = '登録できませんでした';
          return;
        }
        const url = (cfg.APP_BASE || location.origin) + '/?c=' + res.data[0].url_token;
        $('newUrl').textContent = url;
        $('newDone').classList.remove('hide');
        $('newName').value = '';
        $('newContact').value = '';
        toast('✅ ' + name + ' を登録しました');
        loadList();
      });
  };

  $('newCopy').onclick = function () {
    const txt = $('newUrl').textContent || '';
    if (!txt) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(
        function () {
          toast('コピーしました');
        },
        function () {
          toast('長押しでコピーしてください');
        }
      );
    } else {
      toast('長押しでコピーしてください');
    }
  };

  // ── 使う / 止める ──
  //   ★押した瞬間に画面を変え、失敗したら戻す★（待たせない）
  function setStatus(id, next) {
    const r = rows.filter(function (x) {
      return x.id === id;
    })[0];
    if (!r || r.status === next) return;
    const before = r.status;
    r.status = next;
    render();
    sb.from('dk_companies')
      .update({ status: next })
      .eq('company_id', id)
      .then(function (res) {
        if (res.error) {
          r.status = before;
          render();
          toast('変えられませんでした');
          return;
        }
        toast(
          next === 'off'
            ? '⛔ ' + r.name + ' を止めました'
            : '✅ ' + r.name + ' を使えるようにしました'
        );
      });
  }

  // ── 席数 ──
  function setSeat(id, n, el) {
    const r = rows.filter(function (x) {
      return x.id === id;
    })[0];
    if (!r || r.seat === n) return;
    const before = r.seat;
    r.seat = n;
    sb.from('dk_companies')
      .update({ seat_limit: n })
      .eq('company_id', id)
      .then(function (res) {
        if (res.error) {
          r.seat = before;
          if (el) el.value = before;
          toast('変えられませんでした');
          return;
        }
        toast(r.name + ' の席数を ' + n + ' 台にしました');
      });
  }

  boot();
})();
