// POI カテゴリ ID 定義（共有）
// 既存 9（0〜8）は維持・新規 32 は 10 番台以降のグループに振る

const CATEGORIES = {
  // 既存 9
  0:  'hotel',                  // ホテル・宿泊
  1:  'restaurant_bar',         // 飲食・バー（既存「飲食・バー」）
  2:  'convenience_store',      // コンビニ
  3:  'gas_station',            // GS
  4:  'hospital',               // 病院
  5:  'station',                // 駅
  6:  'school',                 // 学校
  7:  'public_facility',        // 公共施設
  8:  'sightseeing',            // 観光スポット

  // 飲食系（追加 6）
  10: 'fast_food',
  11: 'cafe',
  12: 'ramen',
  13: 'sushi',
  14: 'yakiniku',
  15: 'izakaya',

  // 医療系（追加 3）
  20: 'clinic',
  21: 'dental',
  22: 'pharmacy_drugstore',

  // 買い物系（追加 4）
  30: 'supermarket',
  31: 'home_center',
  32: 'department_sc',
  33: 'hundred_yen',

  // 行政系（追加 5）
  40: 'city_office',
  41: 'post_office',
  42: 'police_koban',
  43: 'fire_station',
  44: 'library',

  // 金融系（追加 2）
  50: 'atm',
  51: 'bank',

  // レジャー系（追加 5）
  60: 'onsen_sento',
  61: 'karaoke',
  62: 'pachinko',
  63: 'cinema',
  64: 'golf',

  // ドライブ系（追加 4）
  70: 'michinoeki',
  71: 'sapa',
  72: 'bicycle_parking',
  73: 'taxi_stand',

  // 交通系（追加 2）
  80: 'bus_stop',
  81: 'airport',

  // 防災系（追加 1）
  90: 'aed',
};

// 名前→ID 逆引き（入力 GeoJSON が文字列カテゴリの場合に使用）
const CATEGORY_NAME_TO_ID = {};
for (const [id, name] of Object.entries(CATEGORIES)) CATEGORY_NAME_TO_ID[name] = +id;

// 属性キーの統一規約（短縮）
//   h24:1                24時間営業
//   open:"7:00-22:00"    営業時間
//   fee:"30min/200円"   駐車料金
//   height_m:2.1         駐車場 高さ制限
//   cap:120              駐車場 収容台数
//   self:1 / full:1      GS セルフ／フル
//   diesel:1             GS 軽油対応
//   er:1                 病院 救急
//   kind:"elem"|"jhs"|"hs"|"univ"|"voc"  学校種別

module.exports = { CATEGORIES, CATEGORY_NAME_TO_ID };
