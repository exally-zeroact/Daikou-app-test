// ============================================================
// js/obd-wheelspeed-map.js  (ダイコメ ABS各輪速 CANシード表・2026-06-15)
//
// ★目的★: ELM327(ATH1+ATMA)で傍受した生CANフレームから「どのCAN IDの・どの係数で車輪速になるか」を
//   車種を撃つ前に知るための ★事前シード表★。標準OBD2の010D(1km/h整数floor=系統-2%過小)を、
//   ABS各輪速の高分解能(0.005〜0.057 km/h/LSB=010Dの18〜200倍細かい)に置換し floor量子化を発生源から消す。
//
// ★出典★: commaai/opendbc の各メーカー .dbc を verbatim 確認(2026-06-15 調査・全ID/係数に raw URL 根拠)。
//   ★捏造ゼロ方針★: 確認できた値のみ。推測は note に「推測」と明記。
//
// ★絶対ルール準拠★: 本表は read-only の参照データ。距離コア(pipeline-distance.js)/課金/Viterbi には
//   一切依存しない・触らない。現状は ★解析ツールの正解照合＋将来の runtime VINマップのシード用★(距離未配線)。
//
// 用語: decode は value_kmh = raw * factor + offsetK。
//   endian 'BE'=Motorola(@0) / 'LE'=Intel(@1)。wheelByteOffsets=BE16でバイト境界整列時の各輪先頭バイト。
//   非バイト整列(Honda15bit/Subaru13bit非連続)は wheelByteOffsets=null とし bit仕様を note に残す。
// ============================================================
(function (global) {
  'use strict';

  // メーカー群ごとの輪速メッセージ(主)。id は 11bit を3桁hex大文字に正規化(ATMA出力と一致)。
  const WHEELSPEED_SEED = {
    TOYOTA: {
      makers: ['Toyota', 'Lexus'],
      seedable: true,
      message: 'WHEEL_SPEEDS',
      ids: ['0AA'], // 0xAA = 170
      factor: 0.01,
      offsetK: -67.67,
      endian: 'BE',
      lenBits: 16,
      wheelByteOffsets: { FR: 0, FL: 2, RR: 4, RL: 6 }, // startbit 7/23/39/55
      resolutionKmhPerLsb: 0.01,
      note: '最も堅い。旧プリウス2010系のみ factor=0.0062・unit=mph(同ID)=要実機確認。Daihatsuは多くがトヨタOEMで0xAA最有力(推測)。',
      source:
        'opendbc toyota *_pt_generated.dbc + car/toyota/carstate.py (bus0/powertrain・OBD到達)',
    },
    HONDA: {
      makers: ['Honda', 'Acura'],
      seedable: true,
      message: 'WHEEL_SPEEDS',
      ids: ['1D0'], // 0x1D0 = 464 (送信元 VSA)
      factor: 0.01,
      offsetK: 0,
      endian: 'BE',
      lenBits: 15, // ★非バイト整列(15bit)★
      wheelByteOffsets: null,
      bitStarts: { FL: 7, FR: 8, RL: 25, RR: 42 }, // DBC startbit(Motorola)
      resolutionKmhPerLsb: 0.01,
      note: '単一定義(nidec/Bosch共通)で全車カバー。15bit非連続=byte境界でなくbit抽出要。リポ直下 acura_ilx_2016_nidec.dbc はレーダーdbcで輪速無し=使うな。',
      source: 'opendbc dbc/generator/honda/_honda_common.dbc',
    },
    NISSAN: {
      makers: ['Nissan'],
      seedable: true,
      message: 'WHEEL_SPEEDS_FRONT/REAR',
      ids: ['284', '29A', '285'], // FRONT: Leaf 0x284 / X-Trail 0x29A ・ REAR共通 0x285
      factor: 0.005,
      offsetK: 0,
      endian: 'BE',
      lenBits: 16,
      wheelByteOffsets: { FR: 0, FL: 2, RR: 0, RL: 2 }, // FRONT(284/29A): FR@0 FL@2 / REAR(285): RR@0 RL@2
      resolutionKmhPerLsb: 0.005, // ★最も細かい(010Dの200倍)★
      note: 'FRONT の ID が車種別(Leaf 0x284 / X-Trail 0x29A)。REAR は共通 0x285。Altimaのみ bus1=要実機確認。Infinitiはopendbc未収録=プローブ発見。旧Xterra2011は別仕様。',
      source:
        'opendbc dbc/generator/nissan/nissan_leaf_2018.dbc, nissan_x_trail_2017.dbc, _nissan_common.dbc',
    },
    SUBARU: {
      makers: ['Subaru'],
      seedable: true,
      message: 'Wheel_Speeds',
      ids: ['13A'], // 0x13A = 314 (Global 2017+)
      factor: 0.057,
      offsetK: 0,
      endian: 'LE',
      lenBits: 13, // ★非連続配置(CHECKSUM/COUNTER挟み)★
      wheelByteOffsets: null,
      bitStarts: { FR: 12, RR: 25, RL: 38, FL: 51 },
      resolutionKmhPerLsb: 0.057,
      note: 'Global 2017+。FR/RR入替修正PR履歴あり=コーナーラベル実車照合推奨。OBD到達は要実機確認(GW裏可能性)。旧Pre-Global Outback2015は ID 0xD4/×0.0592=要再確認。',
      source: 'opendbc dbc/generator/subaru/_subaru_global.dbc',
    },
    MAZDA: {
      makers: ['Mazda'],
      seedable: true,
      message: 'WHEEL_SPEEDS',
      ids: ['215', '01C'], // CX-5/CX-9/Mazda6 2017+ = 0x215(533) / Mazda3 2019 = 0x1C(28)
      factor: 0.01,
      offsetK: -100,
      endian: 'BE',
      lenBits: 16,
      wheelByteOffsets: { FL: 0, FR: 2, RL: 4, RR: 6 }, // startbit 7/23/39/55
      resolutionKmhPerLsb: 0.01,
      note: '車種でID違い(0x215 / 0x1C)。Mazda3 2019 は RL のみ offset -102。OBD到達は要実機確認。',
      source: 'opendbc dbc/mazda_2017.dbc, dbc/mazda_3_2019.dbc',
    },
    // ─── opendbc 未収録 = プローブ発見待ち(010Dフォールバック) ───
    PROBE_ONLY: {
      makers: ['Suzuki', 'Daihatsu', 'Mitsubishi', 'Infiniti'],
      seedable: false,
      note: 'opendbc CARS.md 未収録。Daihatsuはトヨタ過半数出資/多数がトヨタOEM→0xAA(Toyota)を最初に試す価値(推測)。Suzukiは一部トヨタ/ダイハツOEM個体のみ0xAA推測。Mitsubishi/Infinitiは推測根拠ゼロ=純プローブ発見。全社フォールバック=標準OBD2 010D。',
      source: 'opendbc docs/CARS.md',
    },
  };

  // 発見ID → メーカー逆引き(解析ツールが「撃ったIDが既知の誰のIDか」を照合する用)。
  const SEED_BY_ID = {};
  Object.keys(WHEELSPEED_SEED).forEach(function (key) {
    const e = WHEELSPEED_SEED[key];
    if (!e.seedable || !e.ids) return;
    e.ids.forEach(function (id) {
      SEED_BY_ID[id.toUpperCase()] = {
        group: key,
        makers: e.makers,
        factor: e.factor,
        offsetK: e.offsetK,
        endian: e.endian,
        resolutionKmhPerLsb: e.resolutionKmhPerLsb,
        note: e.note,
      };
    });
  });

  // 撃った生CAN IDが既知シードのどれかに一致するか(3桁hex正規化して照合)
  function lookupById(idHex) {
    if (typeof idHex !== 'string') return null;
    let id = idHex.toUpperCase().replace(/^0X/, '');
    if (/^[0-9A-F]{1,3}$/.test(id)) id = id.padStart(3, '0'); // 11bitは3桁へ
    return SEED_BY_ID[id] || null;
  }

  function listSeedableMakers() {
    const out = [];
    Object.keys(WHEELSPEED_SEED).forEach(function (k) {
      if (WHEELSPEED_SEED[k].seedable) out.push.apply(out, WHEELSPEED_SEED[k].makers);
    });
    return out;
  }

  const api = {
    WHEELSPEED_SEED: WHEELSPEED_SEED,
    SEED_BY_ID: SEED_BY_ID,
    lookupById: lookupById,
    listSeedableMakers: listSeedableMakers,
  };
  // eslint-disable-next-line no-undef
  if (typeof module !== 'undefined' && module.exports) {
    // eslint-disable-next-line no-undef
    module.exports = api;
  }
  global.OBDWheelSpeedMap = api;
})(
  typeof window !== 'undefined'
    ? window
    : typeof self !== 'undefined'
      ? self
      : typeof globalThis !== 'undefined'
        ? globalThis
        : this
);
