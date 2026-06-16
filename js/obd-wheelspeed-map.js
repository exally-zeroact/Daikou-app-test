// ============================================================
// js/obd-wheelspeed-map.js  (ダイコメ ABS各輪速 CANシード表・2026-06-15 / 2026-06-16 網羅拡充)
//
// ★目的★: ELM327(ATH1+ATMA)で傍受した生CANから「どのCAN IDの・どの係数で車輪速になるか」を
//   車種を撃つ前に知るための ★事前シード表★。標準OBD2 010D(1km/h floor=系統-2%過小)を、ABS各輪速の
//   高分解能(0.005〜0.057 km/h/LSB=010Dの18〜200倍細かい)に置換し floor量子化を発生源から消す。
//
// ★出典★: commaai/opendbc の各メーカー .dbc を verbatim 確認(2026-06-16 網羅調査・全ID/bit/係数に raw URL)。
//   ★捏造ゼロ方針★: 確認できた値のみ。opendbc未収録(スズキ/ダイハツ/三菱の自社車)は「要プローブ発見」。
//
// ★2026-06-16 重要訂正★: TOYOTA 0xAA は ★15bit 非バイト整列(bitStarts FR6/FL22/RR38/RL54)★ が正。
//   旧 16bit byte整列(wheelByteOffsets)は誤デコード→修正。Subaru pre-global(0xD4)/Hyundai-Kia(0x386)新規。
//
// ★絶対ルール準拠★: read-only の参照データ。距離コア(pipeline-distance.js)/課金/Viterbi に依存しない・触らない。
//   現状は ★端末内識別の正解照合(lookupById)＋将来の decode シード用★(距離未配線)。
//
// 構造: WHEELSPEED_SEED[maker] = { makers, seedable, variants:[{ id, message, factor, offsetK, endian('BE'|'LE'),
//   lenBits, wheelByteOffsets|bitStarts, resolutionKmhPerLsb, models, years, busReachable, elm327Readable, source }] }。
//   メーカー内で車種/年式により id/係数が違う(Subaru global vs pre-global 等)ため variants で持つ。
//   SEED_BY_ID は全 variant を id→params で逆引き(撃ったIDが誰のものか即照合)。
//   decode: value_kmh = raw * factor + offsetK。endian 'BE'=Motorola(@0) / 'LE'=Intel(@1)。
// ============================================================
(function (global) {
  'use strict';

  const WHEELSPEED_SEED = {
    TOYOTA: {
      makers: ['Toyota', 'Lexus'],
      seedable: true,
      variants: [
        {
          id: '0AA', // BO_ 170
          message: 'WHEEL_SPEEDS',
          factor: 0.01,
          offsetK: -67.67,
          endian: 'BE',
          lenBits: 15, // ★15bit 非バイト整列(byte境界でなくbit抽出)★
          wheelByteOffsets: null,
          bitStarts: { FR: 6, FL: 22, RR: 38, RL: 54 }, // DBC startbit(Motorola)・順序 FR→FL→RR→RL
          resolutionKmhPerLsb: 0.01,
          models: 'TSS/TSS2 全車(corolla/rav4/camry/prius/lexus等)',
          years: '~2023+',
          busReachable: 'bus0(確定・carstate Bus.pt)',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/toyota/_toyota_2017.dbc',
        },
      ],
      note: '最も堅い(bus0確定)。Daihatsuは多くがトヨタOEMで0xAA最有力(推測)。旧プリウス2010系のみ別仕様(要実機確認)。',
    },
    HONDA: {
      makers: ['Honda', 'Acura'],
      seedable: true,
      variants: [
        {
          id: '1D0', // BO_ 464・送信元VSA
          message: 'WHEEL_SPEEDS',
          factor: 0.01,
          offsetK: 0,
          endian: 'BE',
          lenBits: 15, // 非バイト整列
          wheelByteOffsets: null,
          bitStarts: { FL: 7, FR: 8, RL: 25, RR: 42 },
          resolutionKmhPerLsb: 0.01,
          models: 'nidec/Bosch 全車共通',
          years: '~2022+',
          busReachable: 'bus0(carstate Bus.pt)',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/honda/_honda_common.dbc',
        },
      ],
      note: '単一定義で全車カバー。リポ直下 acura_ilx_2016_nidec.dbc はレーダーdbcで輪速無し=使うな。',
    },
    NISSAN: {
      makers: ['Nissan'],
      seedable: true,
      variants: [
        {
          id: '284', // BO_ 644 Leaf FRONT
          message: 'WHEEL_SPEEDS_FRONT',
          factor: 0.005,
          offsetK: 0,
          endian: 'BE',
          lenBits: 16,
          wheelByteOffsets: { FR: 0, FL: 2 },
          resolutionKmhPerLsb: 0.005,
          models: 'Leaf',
          years: '2018+',
          busReachable: 'bus0(carstate Bus.pt)',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/nissan/nissan_leaf_2018.dbc',
        },
        {
          id: '29A', // BO_ 666 X-Trail FRONT
          message: 'WHEEL_SPEEDS_FRONT',
          factor: 0.005,
          offsetK: 0,
          endian: 'BE',
          lenBits: 16,
          wheelByteOffsets: { FR: 0, FL: 2 },
          resolutionKmhPerLsb: 0.005,
          models: 'X-Trail(Rogue)',
          years: '2017+',
          busReachable: 'bus0',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/nissan/nissan_x_trail_2017.dbc',
        },
        {
          id: '285', // BO_ 645 REAR 共通
          message: 'WHEEL_SPEEDS_REAR',
          factor: 0.005,
          offsetK: 0,
          endian: 'BE',
          lenBits: 16,
          wheelByteOffsets: { RR: 0, RL: 2 },
          resolutionKmhPerLsb: 0.005, // ★最も細かい(010Dの200倍)★
          models: 'Leaf/X-Trail/Altima 共通',
          years: '2017+',
          busReachable: 'bus0(★Altimaのみbus1=OBD不可達→010Dフォールバック★)',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/nissan/_nissan_common.dbc',
        },
      ],
      note: 'FRONTのIDが車種別(Leaf 0x284/X-Trail 0x29A)・REAR共通0x285。Infinitiはopendbc未収録だが0x284系を試す価値(推測)。',
    },
    SUBARU: {
      makers: ['Subaru'],
      seedable: true,
      variants: [
        {
          id: '13A', // BO_ 314 Global
          message: 'Wheel_Speeds',
          factor: 0.057,
          offsetK: 0,
          endian: 'LE',
          lenBits: 13, // 非連続(CHECKSUM/COUNTER挟む)
          wheelByteOffsets: null,
          bitStarts: { FR: 12, RR: 25, RL: 38, FL: 51 },
          resolutionKmhPerLsb: 0.057,
          models: 'Global全車(Impreza/Crosstrek/Forester/Outback/Legacy/Ascent)',
          years: '2017+',
          busReachable: '要実機確認(GW裏の可能性)',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/subaru/_subaru_globalCAN.dbc',
        },
        {
          id: '0D4', // BO_ 212 pre-global ★verbatim確定(旧推測を昇格)★
          message: 'Wheel_Speeds',
          factor: 0.0592,
          offsetK: 0,
          endian: 'LE',
          lenBits: 16,
          wheelByteOffsets: { FL: 0, FR: 2, RL: 4, RR: 6 },
          resolutionKmhPerLsb: 0.0592,
          models: 'Outback/Legacy/Forester (pre-global)',
          years: '2015-2018',
          busReachable: '要実機確認',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/subaru/_subaru_preglobal_2015.dbc',
        },
      ],
      note: 'Global(0x13A)とpre-global(0xD4)でID/係数が違う。FR/RR入替修正PR履歴あり=コーナーラベル実車照合推奨。',
    },
    MAZDA: {
      makers: ['Mazda'],
      seedable: true,
      variants: [
        {
          id: '215', // BO_ 533
          message: 'WHEEL_SPEEDS',
          factor: 0.01,
          offsetK: -100,
          endian: 'BE',
          lenBits: 16,
          wheelByteOffsets: { FL: 0, FR: 2, RL: 4, RR: 6 },
          resolutionKmhPerLsb: 0.01,
          models: 'CX-5/CX-9/Mazda6/Mazda3(~2018)',
          years: '2017+',
          busReachable: '要実機確認',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/mazda_2017.dbc',
        },
        {
          id: '01C', // BO_ 28 Mazda3 2019
          message: 'WHEEL_SPEEDS',
          factor: 0.01,
          offsetK: -100, // ★RLのみ -102★
          endian: 'BE',
          lenBits: 16,
          wheelByteOffsets: { FL: 0, FR: 2, RL: 4, RR: 6 },
          resolutionKmhPerLsb: 0.01,
          models: 'Mazda3(BP)',
          years: '2019+',
          busReachable: '要実機確認',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/mazda_3_2019.dbc',
        },
      ],
      note: '車種でID違い(0x215/0x1C)。Mazda3 2019 の RL のみ offsetK -102。',
    },
    HYUNDAI: {
      makers: ['Hyundai', 'Kia', 'Genesis'],
      seedable: true,
      variants: [
        {
          id: '386', // BO_ 902 WHL_SPD11・classic CAN・送信元ABS
          message: 'WHL_SPD11',
          factor: 0.03125,
          offsetK: 0,
          endian: 'LE',
          lenBits: 14,
          wheelByteOffsets: { FL: 0, FR: 2, RL: 4, RR: 6 },
          resolutionKmhPerLsb: 0.03125,
          models: 'classic CAN 全車',
          years: '~2022(non-CANFD)',
          busReachable: 'classic CCANは多くbus0到達(要実機確認)',
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/hyundai/hyundai_kia_generic.dbc',
        },
        {
          id: '0A0', // BO_ 160 CAN-FD ★ELM327(classic CAN)では物理的に取得不可★
          message: 'WHEEL_SPEEDS',
          factor: 0.03125,
          offsetK: 0,
          endian: 'LE',
          lenBits: 14,
          wheelByteOffsets: { FL: 8, FR: 10, RL: 12, RR: 14 },
          resolutionKmhPerLsb: 0.03125,
          models: 'CAN-FD車(Ioniq5/6,Tucson NX4,Sportage,EV6,GV60等)',
          years: '2021+',
          busReachable: '★CAN-FD=ELM327では取得不可・bus0不可達★',
          elm327Readable: false, // ★ELM327(classic CAN)では読めない→SEED_BY_IDから除外★
          source:
            'https://raw.githubusercontent.com/commaai/opendbc/master/opendbc/dbc/generator/hyundai/hyundai_canfd.dbc',
        },
      ],
      note: '輸入車補足。classic(0x386)はELM327で読める。CAN-FD(0xA0)はELM327非対応=シード照合から除外。',
    },
    // ─── opendbc 未収録 = プローブ発見待ち(010Dフォールバック) ───
    PROBE_ONLY: {
      makers: ['Suzuki', 'Daihatsu', 'Mitsubishi', 'Infiniti'],
      seedable: false,
      variants: [],
      note: 'opendbc未収録。Daihatsuはトヨタ過半数出資/多くがトヨタOEM→0xAA(Toyota)を最初に試す価値(推測)。Suzukiは一部トヨタ/ダイハツOEM個体のみ0xAA推測(モコ=スズキMG33S系=自社車なので根拠なし)。Mitsubishi/Infinitiは推測根拠ほぼゼロ=純プローブ発見。全社フォールバック=標準OBD2 010D。',
    },
  };

  // 発見ID → メーカー/係数 逆引き(解析ツール/端末内識別が「撃ったIDが既知の誰か」を照合)。
  //   ELM327で読めない CAN-FD(elm327Readable:false) は除外。
  const SEED_BY_ID = {};
  Object.keys(WHEELSPEED_SEED).forEach(function (key) {
    const e = WHEELSPEED_SEED[key];
    if (!e.seedable || !e.variants) return;
    e.variants.forEach(function (v) {
      if (v.elm327Readable === false) return;
      SEED_BY_ID[String(v.id).toUpperCase()] = {
        group: key,
        makers: e.makers,
        models: v.models,
        id: v.id,
        factor: v.factor,
        offsetK: v.offsetK,
        endian: v.endian,
        lenBits: v.lenBits,
        resolutionKmhPerLsb: v.resolutionKmhPerLsb,
        note: e.note,
        source: v.source,
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

  // シード可能な ID 一覧(ELM327で読める分のみ)
  function seededIds() {
    return Object.keys(SEED_BY_ID);
  }

  const api = {
    WHEELSPEED_SEED: WHEELSPEED_SEED,
    SEED_BY_ID: SEED_BY_ID,
    lookupById: lookupById,
    listSeedableMakers: listSeedableMakers,
    seededIds: seededIds,
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
