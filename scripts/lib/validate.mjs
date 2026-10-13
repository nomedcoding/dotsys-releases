/**
 * 공휴일 표 검증기 — 앱 `src/shared/holidays/parse.ts` 의 **순수 JS 사본**(ADR-124, 공개 저장소 자동 게시용).
 *
 * 앱(데스크탑·안드로이드)·위젯은 내려받은 `holidays.json` 을 parse.ts / KoreanHolidays.java 로 다시 검사하고,
 * 규칙 위반이 **하나라도** 있으면 파일 전체를 버린다(fail-closed, 마지막 정상 표 유지 — 조용히).
 * 그래서 게시 전에 여기서 **같은 규칙**으로 먼저 거른다. 여기서 통과 못 하면 봇이 커밋하지 않는다(exit 1 → 메일).
 *
 * 이 파일의 세 부분:
 *   1. `validateHolidayTable` / `parseHolidayFeedText` — parse.ts 와 **판정·정규화 결과가 같아야 하는** 사본.
 *      ⚠️ 규칙의 정본은 앱 저장소 parse.ts 다. 앱 쪽 규칙이 바뀌면 이 부분도 같이 바꿀 것
 *      (2026-10-06 기준 상수 7개 일치 + 차등 시험 2만 건 판정·정규화 일치로 확인).
 *   2. `findControlCharNames` — 봇 전용 **추가** 사전 검사(앱보다 엄격): 이름에 제어문자(\p{Cc}) 금지.
 *   3. `explainInvalidTable` — 실패 메일에 "왜" 를 적기 위한 설명기. **판정에는 쓰지 않는다**(판정 = 1번).
 *
 * 정규식은 전부 `\uXXXX` 이스케이프로 적는다 — 보이지 않는 문자·bidi 제어 문자를 소스에 날것으로 두면
 * 편집기에서 안 보여 검토가 불가능하다(리뷰 🟡-8).
 */

export const MAX_FEED_CHARS = 128 * 1024
export const MAX_YEARS = 12
/** 연도표 하한 — 한국 법정공휴일은 연 15~20일. 이보다 적으면 잘린 표로 본다(리뷰 #2). */
export const MIN_ENTRIES_PER_YEAR = 10
export const MAX_ENTRIES_PER_YEAR = 80
export const MAX_NAMES_PER_DATE = 3
export const MAX_NAME_CHARS = 40
export const HOLIDAY_TABLE_FORMAT = 'HOLIDAYS_TABLE_V1'
/** `source` 는 진단 표시용 — 판정에 쓰지 않으므로 거부 대신 절단(parse.ts 와 동일). */
const MAX_SOURCE_CHARS = 200

const KST_OFFSET_MS = 9 * 3600 * 1000

// parse.ts 와 글자 그대로 같은 정규식(자바 미러와도 동일).
const YEAR_KEY_RE = /^[0-9]{4}$/
const DATE_KEY_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/
const ISO_OFFSET_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[.][0-9]{3})?(?:Z|[+-]([0-9]{2}):([0-9]{2}))$/

/** 보이지 않는 조작 문자 — bidi 제어(U+202A–202E, U+2066–2069)·제로폭(U+200B–200F, U+2060–2064, U+FEFF). */
const INVISIBLE_MANIPULATION_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g
export function stripInvisible(s) {
  return s.replace(INVISIBLE_MANIPULATION_RE, '')
}

/** 제어문자(U+0000–001F, U+007F–009F) — 개행·탭·ESC(터미널 색 코드) 등. 봇 전용 추가 검사. */
const CONTROL_CHAR_RE = /\p{Cc}/u

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function daysInMonth(y, m) {
  if (m === 2) return isLeapYear(y) ? 29 : 28
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

/** 실제 달력 날짜인가 — `Date` 를 만들지 않는다(2026-02-30 을 3월 2일로 굴리는 관용 차단). */
export function isRealCalendarDate(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

/** `generated_at` → epoch ms. 형식·범위 위반이면 null. */
export function parseGeneratedAt(v) {
  if (typeof v !== 'string') return null
  const m = ISO_OFFSET_RE.exec(v)
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss, ohs, oms] = m
  const y = Number(ys)
  if (!isRealCalendarDate(y, Number(mos), Number(ds))) return null
  if (Number(hs) > 23 || Number(mis) > 59 || Number(ss) > 59) return null
  if (ohs !== undefined && (Number(ohs) > 23 || Number(oms) > 59)) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/** epoch ms 의 KST 연도 — 오프셋을 더한 뒤 UTC 연도를 읽는다(실행 기기 시간대 무관). */
export function kstYearOf(ms) {
  return new Date(ms + KST_OFFSET_MS).getUTCFullYear()
}

// ─────────────────────────────────────────── 1. parse.ts 사본(판정)

/** 연도 표 1개 검증 + 정규화(키 정렬·이름 trim). 위반이면 null. */
function validateYearTable(yearKey, raw) {
  if (!isPlainObject(raw)) return null
  const dateKeys = Object.keys(raw)
  if (dateKeys.length < MIN_ENTRIES_PER_YEAR || dateKeys.length > MAX_ENTRIES_PER_YEAR) return null

  const out = {}
  for (const dateKey of dateKeys.sort()) {
    const m = DATE_KEY_RE.exec(dateKey)
    if (!m) return null
    if (m[1] !== yearKey) return null
    if (!isRealCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return null

    const names = raw[dateKey]
    if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES_PER_DATE) return null
    const cleaned = []
    for (const name of names) {
      if (typeof name !== 'string') return null
      const n = stripInvisible(name).trim()
      if (n.length === 0 || n.length > MAX_NAME_CHARS) return null
      cleaned.push(n)
    }
    out[dateKey] = cleaned
  }
  return out
}

/**
 * 공휴일 표(이미 JSON 으로 풀린 값) → 정규화된 새 객체. 규칙 위반이 **하나라도** 있으면 null.
 * 반환 모양은 parse.ts 와 같다: { version, format, generated_at, generatedAtMs, source, years }.
 */
export function validateHolidayTable(raw) {
  if (!isPlainObject(raw)) return null
  if (raw.version !== 1) return null
  if (raw.format !== HOLIDAY_TABLE_FORMAT) return null

  const generatedAtMs = parseGeneratedAt(raw.generated_at)
  if (generatedAtMs === null) return null
  const generatedAt = raw.generated_at

  if (!isPlainObject(raw.years)) return null
  const yearKeys = Object.keys(raw.years)
  if (yearKeys.length > MAX_YEARS) return null

  const years = {}
  for (const yearKey of yearKeys.sort()) {
    if (!YEAR_KEY_RE.test(yearKey)) return null
    const table = validateYearTable(yearKey, raw.years[yearKey])
    if (table === null) return null
    years[yearKey] = table
  }

  // 롤링 창이 "올해"를 빠뜨린 표는 거부(리뷰 #2 ②).
  const kstYearKey = String(kstYearOf(generatedAtMs)).padStart(4, '0')
  if (!Object.prototype.hasOwnProperty.call(years, kstYearKey)) return null

  const source =
    typeof raw.source === 'string' ? stripInvisible(raw.source).trim().slice(0, MAX_SOURCE_CHARS) : ''

  return {
    version: 1,
    format: HOLIDAY_TABLE_FORMAT,
    generated_at: generatedAt,
    generatedAtMs,
    source,
    years,
  }
}

/** 피드 원문 → 검증된 표. 반환 null = 앱이 피드 전체를 무시한다(parseHolidayFeedText 와 동일). */
export function parseHolidayFeedText(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_FEED_CHARS) return null
  let root
  try {
    root = JSON.parse(text)
  } catch {
    return null
  }
  return validateHolidayTable(root)
}

// ─────────────────────────────────────────── 2. 봇 전용 추가 검사

/** 정규화된 years 에서 제어문자가 든 이름 목록(`"YYYY-MM-DD" "이름"` 형태, 이스케이프 표기). 없으면 []. */
export function findControlCharNames(years) {
  const out = []
  for (const y of Object.keys(years)) {
    const t = years[y]
    if (!isPlainObject(t)) continue
    for (const d of Object.keys(t)) {
      const names = Array.isArray(t[d]) ? t[d] : []
      for (const n of names) if (typeof n === 'string' && CONTROL_CHAR_RE.test(n)) out.push(`${d} ${JSON.stringify(n)}`)
    }
  }
  return out
}

// ─────────────────────────────────────────── 3. 실패 설명기(판정에 쓰지 않음)

/** validateHolidayTable 이 null 을 낸 **첫 이유**를 사람 말로. 통과하면 null. */
export function explainInvalidTable(raw) {
  if (!isPlainObject(raw)) return '표의 최상위가 객체가 아님'
  if (raw.version !== 1) return `version 이 1 이 아님: ${JSON.stringify(raw.version)}`
  if (raw.format !== HOLIDAY_TABLE_FORMAT) return `format 이 ${HOLIDAY_TABLE_FORMAT} 가 아님: ${JSON.stringify(raw.format)}`
  const ms = parseGeneratedAt(raw.generated_at)
  if (ms === null) return `generated_at 형식·범위 불량(초·타임존 필수): ${JSON.stringify(raw.generated_at)}`
  if (!isPlainObject(raw.years)) return 'years 가 객체가 아님'
  const keys = Object.keys(raw.years).sort()
  if (keys.length > MAX_YEARS) return `연도 ${keys.length}개 > 상한 ${MAX_YEARS}`
  for (const y of keys) {
    if (!YEAR_KEY_RE.test(y)) return `연도 키 형식 불량: ${JSON.stringify(y)}`
    const t = raw.years[y]
    if (!isPlainObject(t)) return `${y}년 표가 객체가 아님`
    const n = Object.keys(t).length
    if (n < MIN_ENTRIES_PER_YEAR) {
      return `${y}년 항목 ${n}건 < 하한 ${MIN_ENTRIES_PER_YEAR} — 상류가 아직 그해 표를 내지 않았는데 overrides.add 로 먼저 넣었나?`
    }
    if (n > MAX_ENTRIES_PER_YEAR) return `${y}년 항목 ${n}건 > 상한 ${MAX_ENTRIES_PER_YEAR}`
    for (const d of Object.keys(t).sort()) {
      const m = DATE_KEY_RE.exec(d)
      if (!m) return `날짜 키 형식 불량: ${JSON.stringify(d)}`
      if (m[1] !== y) return `날짜 ${d} 가 ${y}년 표 안에 있음(연도 불일치)`
      if (!isRealCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return `없는 날짜: ${d}`
      const names = t[d]
      if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES_PER_DATE) {
        return `${d} 의 이름은 1~${MAX_NAMES_PER_DATE}개 배열이어야 함: ${JSON.stringify(names)}`
      }
      for (const name of names) {
        if (typeof name !== 'string') return `${d} 의 이름이 문자열이 아님: ${JSON.stringify(name)}`
        const c = stripInvisible(name).trim()
        if (c.length === 0) return `${d} 에 빈 이름`
        if (c.length > MAX_NAME_CHARS) return `${d} 의 이름이 ${c.length}자 > ${MAX_NAME_CHARS}자: ${JSON.stringify(c)}`
      }
    }
  }
  const ky = String(kstYearOf(ms)).padStart(4, '0')
  if (!keys.includes(ky)) {
    return `generated_at 의 연도(${ky}, KST)가 years 에 없음 — 새해 표를 상류가 아직 안 냈다(상류 발행 전까지는 표가 바뀌는 변경만 막힌다)`
  }
  return null
}
