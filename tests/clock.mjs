// Preloaded by the S.1 test: shifts the process clock (Date and Date.now) to ORZ_TEST_CLOCK.
const at = Date.parse(process.env.ORZ_TEST_CLOCK ?? '2001-01-01T00:00:00Z');
const RealDate = Date;
const offset = at - RealDate.now();
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a); }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = FakeDate;
