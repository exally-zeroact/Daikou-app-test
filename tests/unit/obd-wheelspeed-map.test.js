// tests/unit/obd-wheelspeed-map.test.js
// ★ABS輪速 CANシード表 検証 (2026-06-15・opendbc由来・出典付き)★
//   js/obd-wheelspeed-map.js は撃った生CAN IDを既知の輪速ID(opendbc verbatim)に照合する参照データ。
//   ★read-only・距離コアには触れない★。値の正しさ(出典どおり)と逆引きを固定する。
const SEED = require('../../js/obd-wheelspeed-map.js');

describe('ABS輪速 CANシード表', () => {
  it('★5メーカー群が事前シード可能(verbatim確認)', () => {
    const makers = SEED.listSeedableMakers();
    ['Toyota', 'Lexus', 'Honda', 'Acura', 'Nissan', 'Subaru', 'Mazda'].forEach((m) =>
      expect(makers).toContain(m)
    );
  });

  it('★Toyota 0xAA → factor 0.01・BE・分解能0.01(010Dの100倍)', () => {
    const s = SEED.lookupById('0AA');
    expect(s).toBeTruthy();
    expect(s.makers).toContain('Toyota');
    expect(s.factor).toBe(0.01);
    expect(s.endian).toBe('BE');
    expect(s.resolutionKmhPerLsb).toBe(0.01);
  });

  it('★Nissan 0x285(REAR共通) → factor 0.005(最も細かい・010Dの200倍)', () => {
    const s = SEED.lookupById('285');
    expect(s.makers).toContain('Nissan');
    expect(s.factor).toBe(0.005);
  });

  it('★Subaru 0x13A → LE・factor 0.057', () => {
    const s = SEED.lookupById('13A');
    expect(s.endian).toBe('LE');
    expect(s.factor).toBe(0.057);
  });

  it('★Mazda は車種別2ID(0x215 / 0x1C)とも引ける', () => {
    expect(SEED.lookupById('215').makers).toContain('Mazda');
    expect(SEED.lookupById('01C').makers).toContain('Mazda'); // 0x1C は3桁正規化で 01C
  });

  it('★ID正規化: 0x接頭辞/小文字/桁不足を3桁hexへ揃えて逆引き', () => {
    expect(SEED.lookupById('0x1d0').makers).toContain('Honda');
    expect(SEED.lookupById('1d0').makers).toContain('Honda');
  });

  it('★未収録(Suzuki/Daihatsu/Mitsubishi系の架空ID)は null = 010Dフォールバック', () => {
    expect(SEED.lookupById('7FF')).toBeNull();
    expect(SEED.lookupById('000')).toBeNull();
    expect(SEED.lookupById('zzz')).toBeNull();
  });

  it('★PROBE_ONLY群(Suzuki/Daihatsu/Mitsubishi/Infiniti)は seedable=false で列挙される', () => {
    expect(SEED.WHEELSPEED_SEED.PROBE_ONLY.seedable).toBe(false);
    ['Suzuki', 'Daihatsu', 'Mitsubishi', 'Infiniti'].forEach((m) =>
      expect(SEED.WHEELSPEED_SEED.PROBE_ONLY.makers).toContain(m)
    );
  });
});
