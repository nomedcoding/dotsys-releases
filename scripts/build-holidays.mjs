#!/usr/bin/env node
/**
 * 공휴일 표 자동 게시 생성기 — 공개 저장소 `nomedcoding/dotsys-releases` 전용
 * (ADR-124 공휴일 데이터 채널 추기: 운영 기본값 = 봇 자동 갱신, 사람은 예외 알림만).
 *
 * 앱 저장소 `scripts/build-holidays.mts` 의 규칙을 **의존성 0 순수 JS** 로 옮긴 것(Node 22, ESM).
 * 유일한 외부 입력 = 상류 패키지 `@hyunbinseo/holidays-kr`(관보 기반) — 워크플로가 매번 @latest 로 설치한다.
 *
 * 입력:
 *   A. 상류 `@hyunbinseo/holidays-kr/all` 의 연도표(`y2018`…) 중 2025 이상(게시 창 하한, 리뷰 #2 ④)
 *   B. 저장소 루트의 직전 `holidays.json`(첫 실행엔 없을 수 있음) — 직전에 있던 연도는 상류가 빼도 유지
 *   C. 저장소 루트의 `holidays.overrides.json` — { note, add: {"YYYY-MM-DD": ["이름"]}, remove: ["YYYY-MM-DD"] }
 *      상류가 아직 못 실은 임시공휴일을 먼저 넣거나(add), 잘못 실린 날짜를 회수(remove)할 때만 사람이 고친다.
 * 출력: 저장소 루트 `holidays.json`(HOLIDAYS_TABLE_V1, 결정적: 정렬된 키·2칸 들여쓰기·끝 개행)
 *
 * 안전장치(전부 fail-closed — 하나라도 걸리면 exit 1, 파일을 쓰지 않는다 → 워크플로 실패 → 소유자에게 메일):
 *   - 날짜 단조성: 직전 표에 있던 날짜는 새 표에도 있어야 한다(overrides.remove 또는 --allow-remove 만 예외).
 *     상류 회귀·창 탈락으로 공휴일이 조용히 사라지는 경로 차단(리뷰 #2·#11).
 *   - 이름 단조성: 양쪽에 다 있는 날짜는 `직전 이름 ⊆ 신규 이름` + **첫 이름 동일**(단일 슬롯 소비자 = names[0]).
 *     예외는 overrides.remove 또는 --allow-rename. ★앱 생성기는 --allow-remove 하나로 둘 다 풀지만,
 *     여기서는 리뷰 B 🟡-5 대로 두 플래그를 **분리**했다(날짜 회수 허가가 개명까지 풀지 않게).
 *   - 산출물은 앱과 **같은 규칙의 검증기**(`lib/validate.mjs` = parse.ts 사본) + 128KB 상한을 통과해야 쓴다.
 *   - generated_at 은 표가 바뀔 때만 "지금(KST)" 으로, 그리고 직전 값보다 **엄격히 새로워야** 한다
 *     (앱은 연도별 newer-wins — 옛 도장의 표는 기기의 더 새 내장 표에 진다).
 *   - 안정성: years 가 직전과 같으면 직전 파일을 **바이트 그대로** 둔다(상류 버전만 바뀐 경우 포함 — 커밋 안 생김).
 *   - overrides 원문에 같은 키가 두 번 있으면 거부(JSON 은 마지막 것만 남기고 앞의 것을 조용히 버린다, 리뷰 #11).
 *   - 그럴듯함 검사(생성·검증 두 모드 공통, 적대적 리뷰 🔴 — 앱 파서가 막지 못하는 "형식은 맞는 가짜" 차단):
 *       ① years 가 바뀌면 generated_at 이 지금 기준 -6시간 ~ +10분 안 + 직전보다 엄격히 새로움.
 *          years 가 같으면(재직렬화) generated_at 은 직전과 **같아야** 한다.
 *       ② 한 번에 늘어나는 양 상한: 새 연도 ≤ 1개이고 그 값은 직전 최대 연도 + 1 / 기존 연도에 새 날짜 ≤ 5건 /
 *          기존 날짜에 이름 추가 ≤ 3개. 넘으면 멈춤 — `--allow-bulk`(수동 실행 입력 allow_bulk)로만 통과.
 *       ③ 이름에 제어문자(\p{Cc}: 개행·ESC 색 코드 등) 금지 — 앱 parse.ts 보다 엄격한 봇 전용 검사. 우회 불가.
 *   - 13번째 연도 예외(리뷰 🟡-5 f): 새 표가 12개 연도이고 사라진 날짜가 **직전 최소 연도 전체뿐**이면
 *     (= 상한 12년에 밀려 가장 오래된 해가 빠진 것) 경고 1줄과 함께 통과. 다른 삭제가 하나라도 섞이면 멈춤.
 *
 * 모드:
 *   (기본)  node scripts/build-holidays.mjs [--allow-remove] [--allow-rename] [--allow-bulk]
 *           상류 → holidays.json. 바뀌었으면 `.holidays-commit-msg`(커밋 메시지)도 쓴다.
 *   검증    node scripts/build-holidays.mjs --verify <후보 파일> [--allow-remove] [--allow-rename] [--allow-bulk]
 *           상류 코드를 **실행하지 않고** 후보 표를 다시 검사한 뒤 holidays.json 으로 들인다.
 *           쓰기 권한이 있는 워크플로 잡(publish) 전용 — 상류 패키지는 읽기 전용 잡(build)에서만 실행된다.
 *
 * 종료 코드: 0 = 정상(changed | unchanged) / 1 = 실패. stdout 은 요약 한 줄뿐, 세부·경고는 stderr.
 *   holidays: <changed|unchanged> years=<목록> entries=<연도:건수,…> source=<상류 버전>
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  HOLIDAY_TABLE_FORMAT,
  MAX_FEED_CHARS,
  MAX_YEARS,
  explainInvalidTable,
  findControlCharNames,
  isPlainObject,
  parseGeneratedAt,
  parseHolidayFeedText,
  stripInvisible,
  validateHolidayTable,
} from './lib/validate.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = path.join(ROOT, 'holidays.json')
const OVERRIDES_FILE = path.join(ROOT, 'holidays.overrides.json')
/** 바뀐 날만 쓰는 커밋 메시지 — 워크플로가 `git commit -F` 로 읽는다(.gitignore 대상). */
const MSG_FILE = path.join(ROOT, '.holidays-commit-msg')
const UPSTREAM_PKG = '@hyunbinseo/holidays-kr'
/** 게시 창 하한(리뷰 #2 ④) — 상류에만 적용. 직전 표에 있던 연도는 하한과 무관하게 유지. */
const WINDOW_FLOOR_YEAR = 2025
const SIMPLE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,39}$/
/** 이 생성기가 쓰는 source 문자열 모양 — 검증 모드에서 "우리 생성기가 만든 후보인가" 를 본다. */
const SOURCE_RE = /^@hyunbinseo\/holidays-kr ([0-9][0-9A-Za-z.+-]{0,39}) \+ overrides\(add ([0-9]+), remove ([0-9]+)\)$/
/** 그럴듯함 ① — 표가 바뀔 때 generated_at 허용 창(지금 기준). build→publish 사이는 수 분이라 6시간이면 넉넉하다. */
const STAMP_PAST_MS = 6 * 3600 * 1000
const STAMP_FUTURE_MS = 10 * 60 * 1000
/** 그럴듯함 ② — 한 번에 늘어나는 양 상한(넘으면 --allow-bulk 필요). 임시공휴일은 보통 한 번에 1~2건. */
const MAX_NEW_YEARS = 1
const MAX_NEW_DATES_IN_EXISTING_YEARS = 5
const MAX_ADDED_NAMES = 3

// ─────────────────────────────────────────────────────────── 공용 도우미

function fail(msg) {
  console.error(`\n❌ holidays: ${msg}\n`)
  process.exit(1)
}

function warn(msg) {
  console.error(`⚠ ${msg}`)
}

function info(msg) {
  console.error(`  · ${msg}`)
}

/** GitHub Actions 단계 출력(`$GITHUB_OUTPUT`) — 로컬 실행에선 아무것도 안 한다. */
function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT
  if (f) fs.appendFileSync(f, `${name}=${value}\n`)
}

/** 지금(KST)을 `YYYY-MM-DDTHH:mm:ss+09:00` 로(앱 생성기와 같은 식). */
function nowKstIso() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000)
  return kst.toISOString().slice(0, 19) + '+09:00'
}

/** 정규 직렬화 — 키 순서 `version, format, generated_at, source, years` 고정, 2칸 들여쓰기, 끝 개행. */
function serialize(t) {
  const obj = {
    version: t.version,
    format: t.format,
    generated_at: t.generated_at,
    source: t.source,
    years: t.years,
  }
  return JSON.stringify(obj, null, 2) + '\n'
}

/** 연도·날짜 키 정렬 사본(이름 배열 순서 보존). 손으로 망가진 직전 원문에도 던지지 않는다. */
function sortYearsLoose(years) {
  const out = {}
  if (!isPlainObject(years)) return out
  for (const y of Object.keys(years).sort()) {
    const t = years[y]
    if (!isPlainObject(t)) {
      out[y] = t
      continue
    }
    const tt = {}
    for (const d of Object.keys(t).sort()) tt[d] = Array.isArray(t[d]) ? [...t[d]] : t[d]
    out[y] = tt
  }
  return out
}

function hasOwn(o, k) {
  return isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k)
}

/** 이름 정규화 — 앱 검증기와 같은 식(보이지 않는 조작 문자 제거 + trim). 문자열이 아니면 그대로. */
function normName(n) {
  return typeof n === 'string' ? stripInvisible(n).trim() : n
}

/**
 * 직전 원문 years 를 **신규와 같은 정규화**(키 정렬 + 이름 normName)로 맞춘 사본 — 비교 전용(2차 리뷰 🟡-2).
 * 직전 파일의 `"설날 "` 같은 공백 차이는 기기에서 어차피 같은 값이므로 "바뀜"·"개명" 으로 보지 않는다.
 */
function normYearsLoose(years) {
  const out = sortYearsLoose(years)
  for (const y of Object.keys(out)) {
    const t = out[y]
    if (!isPlainObject(t)) continue
    for (const d of Object.keys(t)) if (Array.isArray(t[d])) t[d] = t[d].map(normName)
  }
  return out
}

/**
 * JSON 원문에서 같은 객체 안의 중복 키를 찾는다 — JSON.parse 는 마지막 것만 남기고 앞의 것을
 * **조용히** 버린다(리뷰 #11). 문법 검사는 JSON.parse 가 먼저 끝냈다는 전제의 가벼운 토큰 훑기.
 */
function findDuplicateKeys(text) {
  const dups = []
  const stack = [] // { keys: Set | null(배열), expectKey }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      const top = stack[stack.length - 1]
      if (top && top.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1))
        if (top.keys.has(key)) dups.push(key)
        top.keys.add(key)
        top.expectKey = false
      }
      i = j + 1
      continue
    }
    if (c === '{') stack.push({ keys: new Set(), expectKey: true })
    else if (c === '[') stack.push({ keys: null, expectKey: false })
    else if (c === '}' || c === ']') stack.pop()
    else if (c === ',') {
      const top = stack[stack.length - 1]
      if (top && top.keys) top.expectKey = true
    }
    i++
  }
  return dups
}

/** 직전 holidays.json — 없으면 null, JSON 파손이면 실패(손으로 고친 흔적). */
function readPrevious() {
  if (!fs.existsSync(OUT_FILE)) return null
  const text = fs.readFileSync(OUT_FILE, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    fail(
      `직전 holidays.json 의 JSON 이 깨져 있음(${e.message}) — 손으로 고친 흔적?\n` +
        `   GitHub 에서 holidays.json 의 History → 마지막 정상 커밋으로 되돌린 뒤 Actions 에서 다시 실행`
    )
  }
  if (!isPlainObject(raw)) fail('직전 holidays.json 의 최상위가 객체가 아님 — 마지막 정상 커밋으로 되돌릴 것')
  // 비교용 원문은 줄끝을 LF 로 맞춘다 — Windows 에서 core.autocrlf=true 로 받은 사본은 CRLF 라서, 그대로 비교하면
  // 내용이 같아도 "정규 모양 아님 → changed" 로 오판한다(2026-10-06 로컬 e2e 실측. 저장소 blob 은 LF).
  return { text: text.replace(/\r\n/g, '\n'), raw, years: isPlainObject(raw.years) ? raw.years : {} }
}

/** holidays.overrides.json — 형식·중복 키 검사까지. */
function readOverrides() {
  const FORMAT = 'holidays.overrides.json 형식: { "note": "…", "add": {"YYYY-MM-DD": ["이름"]}, "remove": ["YYYY-MM-DD"] }'
  if (!fs.existsSync(OVERRIDES_FILE)) {
    fail(`holidays.overrides.json 이 없음 — 저장소 루트에 있어야 한다(빈 add/remove 라도).\n   ${FORMAT}`)
  }
  const text = fs.readFileSync(OVERRIDES_FILE, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    fail(`holidays.overrides.json 의 JSON 이 깨져 있음(${e.message}) — 쉼표·따옴표·괄호 확인.\n   ${FORMAT}`)
  }
  const dups = findDuplicateKeys(text)
  if (dups.length > 0) {
    fail(
      `holidays.overrides.json 에 같은 키가 두 번: ${dups.join(', ')}\n` +
        `   JSON 은 마지막 것만 남기고 앞의 것을 조용히 버린다. 같은 날짜에 이름을 더하려면 한 줄의 배열에: ["이름1", "이름2"]`
    )
  }
  if (!isPlainObject(raw) || !isPlainObject(raw.add) || !Array.isArray(raw.remove)) fail(FORMAT)
  for (const [date, names] of Object.entries(raw.add)) {
    if (!SIMPLE_DATE_RE.test(date)) fail(`overrides.add 날짜 키 형식 불량: ${date} (YYYY-MM-DD)`)
    if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === 'string')) {
      fail(`overrides.add["${date}"] 는 비어 있지 않은 문자열 배열이어야 함 — 예: ["임시공휴일"]`)
    }
  }
  for (const date of raw.remove) {
    if (typeof date !== 'string' || !SIMPLE_DATE_RE.test(date)) {
      fail(`overrides.remove 항목 형식 불량: ${JSON.stringify(date)} (YYYY-MM-DD 문자열)`)
    }
  }
  const removeSet = new Set(raw.remove)
  for (const date of Object.keys(raw.add)) {
    if (removeSet.has(date)) warn(`overrides: ${date} 가 add 와 remove 에 둘 다 있음 — remove 가 이긴다(날짜 삭제)`)
  }
  return { add: raw.add, remove: raw.remove, removeSet }
}

/** 날짜 단조성 위반 목록 — 직전에 있던 날짜가 새 표에 없는 것(remove·--allow-remove 예외). */
function findMissingDates(oldYears, newYears, removeSet, allowRemove) {
  const missing = []
  for (const y of Object.keys(oldYears)) {
    const oldTable = isPlainObject(oldYears[y]) ? oldYears[y] : {}
    for (const date of Object.keys(oldTable)) {
      if (hasOwn(newYears[y], date)) continue
      if (removeSet.has(date) || allowRemove) continue
      missing.push({ year: y, date, text: `${date} ${JSON.stringify(oldTable[date])}` })
    }
  }
  return missing
}

/**
 * 날짜 단조성 판정(생성·검증 공통). 위반이면 멈춘다. 단 13번째 연도 예외(리뷰 🟡-5 f):
 * 새 표가 정확히 12개 연도이고, 사라진 날짜가 **직전 최소 연도 전체뿐**이면(= 상한에 밀려 가장 오래된 해가
 * 통째로 빠짐) 경고 1줄로 통과. 다른 날짜가 하나라도 같이 사라졌으면 예외 없이 멈춘다.
 */
function checkMissing(oldYears, newYears, removeSet, allowRemove) {
  const missing = findMissingDates(oldYears, newYears, removeSet, allowRemove)
  if (missing.length === 0) return
  const prevYearKeys = Object.keys(oldYears).sort()
  const minY = prevYearKeys[0]
  const exempt =
    Object.keys(newYears).length === MAX_YEARS &&
    !hasOwn(newYears, minY) &&
    missing.every((m) => m.year === minY)
  if (exempt) {
    warn(
      `13번째 연도: 상한 ${MAX_YEARS}년에 밀려 가장 오래된 ${minY}년 표(${missing.length}건)를 뺀다 — ` +
        `이미 받은 기기는 그 해를 캐시에 계속 갖고, 새 설치 기기에서는 ${minY}년 공휴일이 안 보인다`
    )
    return
  }
  failMissing(missing.map((m) => m.text))
}

/**
 * 이름 단조성 위반 목록 — 양쪽에 다 있는 날짜: 직전 이름 ⊆ 신규 이름 + 첫 이름 동일
 * (remove·--allow-rename 예외). newYears 는 **검증기가 정규화한** 값이어야 한다(공백 차이로 거짓 위반 방지).
 */
function findNameViolations(oldYears, newYears, removeSet, allowRename) {
  const out = []
  for (const y of Object.keys(oldYears)) {
    const oldTable = isPlainObject(oldYears[y]) ? oldYears[y] : {}
    const newTable = newYears[y]
    if (!isPlainObject(newTable)) continue // 연도 부재 = 날짜 단조성 영역
    for (const date of Object.keys(oldTable)) {
      if (!hasOwn(newTable, date)) continue // 날짜 부재 = 날짜 단조성 영역
      if (removeSet.has(date) || allowRename) continue
      // 직전 이름도 신규와 같은 정규화 후 비교(2차 리뷰 🟡-2) — 공백·보이지 않는 문자 차이로 거짓 개명이 나지 않게.
      const before = Array.isArray(oldTable[date])
        ? oldTable[date].filter((n) => typeof n === 'string').map(normName)
        : []
      const after = newTable[date]
      const dropped = before.filter((n) => !after.includes(n))
      const firstChanged = before.length > 0 && before[0] !== after[0]
      if (dropped.length === 0 && !firstChanged) continue
      const why = []
      if (dropped.length > 0) why.push(`빠진 이름 ${JSON.stringify(dropped)}`)
      if (firstChanged) why.push(`첫 이름 변경 ${JSON.stringify(before[0])} → ${JSON.stringify(after[0])}`)
      out.push(`${date}: 직전 ${JSON.stringify(before)} → 신규 ${JSON.stringify(after)} (${why.join(', ')})`)
    }
  }
  return out
}

function failMissing(missing) {
  fail(
    `직전 표에 있던 날짜 ${missing.length}건이 새 표에서 사라짐 — 공휴일이 조용히 빠지는 변경이라 멈췄다:\n` +
      missing.map((s) => `   - ${s}`).join('\n') +
      `\n   상류가 정말로 뺀 것이 맞으면: holidays.overrides.json 의 "remove" 에 그 날짜를 넣고 Actions 에서 Run workflow` +
      `\n   (또는 Run workflow 화면에서 "날짜 삭제 허용" 체크 — 그 한 번만 적용된다)`
  )
}

function failNames(violations) {
  fail(
    `직전 표와 이름이 어긋나는 날짜 ${violations.length}건 — 공휴일 이름·첫 라벨이 조용히 바뀌는 변경이라 멈췄다:\n` +
      violations.map((s) => `   - ${s}`).join('\n') +
      `\n   의도된 개명·순서 변경이 맞으면: Actions → Run workflow 화면에서 "이름 변경 허용" 체크 후 실행(그 한 번만 적용)` +
      `\n   (날짜 자체를 회수하려면 holidays.overrides.json 의 "remove")`
  )
}

/** 제어문자 이름(그럴듯함 ③) — 우회 플래그 없음. */
function checkControlChars(years) {
  const bad = findControlCharNames(years)
  if (bad.length > 0) {
    fail(
      `이름에 제어문자(개행·탭·ESC 색 코드 등)가 들어 있음 — 게시하지 않는다:\n` +
        bad.map((s) => `   - ${s}`).join('\n') +
        `\n   holidays.overrides.json 의 add 이름을 확인(상류 데이터면 상류 결함 — 개발 세션)`
    )
  }
}

/**
 * 그럴듯함 ①② (생성·검증 공통, 적대적 리뷰 🔴). table = 검증기 통과본.
 *   ① years 가 바뀌었거나 직전 도장이 무효면: 지금 기준 -6시간 ~ +10분 + 직전보다 엄격히 새로움.
 *      years 가 같으면(재직렬화): generated_at 이 직전과 글자 그대로 같아야 한다.
 *   ② 늘어나는 양 상한(직전 표가 있을 때만, --allow-bulk 로 통과).
 */
function checkPlausibility(prev, oldYears, table, opts) {
  const problems = []
  const nowMs = Date.now()
  const prevMs = prev ? parseGeneratedAt(prev.raw.generated_at) : null
  const yearsChanged = !prev || JSON.stringify(normYearsLoose(oldYears)) !== JSON.stringify(table.years)

  if (yearsChanged || prevMs === null) {
    if (table.generatedAtMs < nowMs - STAMP_PAST_MS || table.generatedAtMs > nowMs + STAMP_FUTURE_MS) {
      problems.push(
        `도장 범위 밖: generated_at ${table.generated_at} 이 지금(${new Date(nowMs).toISOString()}) 기준 ` +
          `-6시간 ~ +10분 범위 밖 — 변조된 후보이거나 실행 기기 시계 이상`
      )
    }
    if (prevMs !== null && table.generatedAtMs <= prevMs) {
      problems.push(
        `새 generated_at(${table.generated_at})이 직전(${prev.raw.generated_at})보다 새롭지 않음 — ` +
          `기기가 새 표를 "옛것"으로 보고 무시한다. 직전 holidays.json 의 도장이 미래 시각으로 손편집됐는지 확인`
      )
    }
  } else {
    if (table.generated_at !== prev.raw.generated_at) {
      problems.push(
        `years 가 직전과 같은데 generated_at 이 바뀜(${prev.raw.generated_at} → ${table.generated_at}) — ` +
          `내용이 같은 재직렬화는 도장을 바꾸면 안 된다`
      )
    }
    // 승계하는 직전 도장에도 상한(2차 리뷰 🟡-1) — 손편집된 미래 도장을 봇이 정규화 커밋으로 "세탁" 해 주지 않게.
    // 하한은 없다(옛 도장은 그대로 승계 — 내용이 같으므로).
    if (table.generatedAtMs > nowMs + STAMP_FUTURE_MS) {
      problems.push(
        `도장 범위 밖: 승계하려는 직전 도장 ${table.generated_at} 이 지금(${new Date(nowMs).toISOString()}) 기준 +10분보다 미래 — ` +
          `직전 holidays.json 의 도장이 손편집됐다. 그 시각이 지난 뒤 Run workflow`
      )
    }
  }

  if (prev && !opts.allowBulk) {
    const prevYearNums = Object.keys(oldYears).filter((y) => /^[0-9]{4}$/.test(y)).map(Number)
    const maxPrev = prevYearNums.length > 0 ? Math.max(...prevYearNums) : null
    const newYearKeys = Object.keys(table.years).filter((y) => !hasOwn(oldYears, y))
    if (
      newYearKeys.length > MAX_NEW_YEARS ||
      (newYearKeys.length === 1 && maxPrev !== null && Number(newYearKeys[0]) !== maxPrev + 1)
    ) {
      problems.push(
        `한 번에 너무 많이 늘어남: 새 연도 ${JSON.stringify(newYearKeys)} — 한 번에 1개, 그리고 직전 최대 연도(${maxPrev}) + 1 만 자동 허용`
      )
    }
    let newDates = 0
    let addedNames = 0
    const newDateList = []
    for (const y of Object.keys(table.years)) {
      if (!hasOwn(oldYears, y)) continue
      const before = isPlainObject(oldYears[y]) ? oldYears[y] : {}
      for (const [d, names] of Object.entries(table.years[y])) {
        if (!hasOwn(before, d)) {
          newDates++
          newDateList.push(d)
        } else {
          const prevNames = Array.isArray(before[d]) ? before[d].map(normName) : []
          addedNames += names.filter((n) => !prevNames.includes(n)).length
        }
      }
    }
    if (newDates > MAX_NEW_DATES_IN_EXISTING_YEARS) {
      problems.push(
        `한 번에 너무 많이 늘어남: 기존 연도에 새 날짜 ${newDates}건 > ${MAX_NEW_DATES_IN_EXISTING_YEARS}건 ` +
          `(${newDateList.slice(0, 8).join(', ')}${newDateList.length > 8 ? ' …' : ''})`
      )
    }
    if (addedNames > MAX_ADDED_NAMES) {
      problems.push(`한 번에 너무 많이 늘어남: 기존 날짜에 이름 추가 ${addedNames}개 > ${MAX_ADDED_NAMES}개`)
    }
  }

  if (problems.length > 0) {
    fail(
      `그럴듯함 검사 불통과 — 게시하지 않는다:\n` +
        problems.map((s) => `   - ${s}`).join('\n') +
        `\n   "한 번에 너무 많이 늘어남" 만 있고 로그의 + 줄이 정말 맞는 변경이면: Run workflow 에서 "한꺼번에 많이 허용(allow_bulk)" 체크`
    )
  }
}

/** 직전 → 신규 변경 내역(커밋 본문·로그용). */
function describeChanges(oldYears, newYears) {
  const lines = []
  const old = normYearsLoose(oldYears)
  const allYears = [...new Set([...Object.keys(old), ...Object.keys(newYears)])].sort()
  for (const y of allYears) {
    const a = isPlainObject(old[y]) ? old[y] : {}
    const b = isPlainObject(newYears[y]) ? newYears[y] : {}
    if (!(y in old)) {
      lines.push(`+ ${y}년 표 추가(${Object.keys(b).length}건)`)
      continue // 새 연도는 건수 한 줄로 충분
    }
    if (!(y in newYears)) lines.push(`- ${y}년 표 삭제`)
    const dates = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    for (const d of dates) {
      if (!hasOwn(b, d)) lines.push(`- ${d} ${JSON.stringify(a[d])}`)
      else if (!hasOwn(a, d)) lines.push(`+ ${d} ${JSON.stringify(b[d])}`)
      else if (JSON.stringify(a[d]) !== JSON.stringify(b[d])) {
        lines.push(`~ ${d} ${JSON.stringify(a[d])} → ${JSON.stringify(b[d])}`)
      }
    }
  }
  return lines
}

function summaryLine(state, years, version) {
  const ys = Object.keys(years).sort()
  const entries = ys.map((y) => `${y}:${Object.keys(years[y]).length}`).join(',')
  return `holidays: ${state} years=${ys.join(',')} entries=${entries} source=${version}`
}

function commitMessage(generatedAt, version, changes) {
  // 내용이 같은 재직렬화(첫 게시 시드·손편집 모양 복구)는 "갱신" 과 구별되게 — 이력에서 오해하지 않도록.
  const subject =
    changes.length === 0
      ? `chore(holidays): 표 모양 정규화 — 내용·도장 불변 ${generatedAt} (상류 ${version})`
      : `chore(holidays): 표 자동 갱신 — ${generatedAt} (상류 ${version})`
  const body = changes.length > 40 ? [...changes.slice(0, 40), `… 외 ${changes.length - 40}줄`] : changes
  return body.length > 0 ? `${subject}\n\n${body.join('\n')}\n` : `${subject}\n`
}

/** 쓰고 나서 다시 읽어 앱 파서로 한 번 더 — 쓰기 도중 잘림·인코딩 사고를 게시 전에 잡는다. */
function writeAndReadBack(text) {
  fs.writeFileSync(OUT_FILE, text)
  const back = fs.readFileSync(OUT_FILE, 'utf8')
  if (back !== text || parseHolidayFeedText(back) === null) {
    fail('holidays.json 을 쓴 뒤 다시 읽은 내용이 다르거나 검증 불통과 — 디스크/인코딩 문제. 커밋하지 않는다')
  }
}

// ─────────────────────────────────────────────────────────── 상류

async function loadUpstream() {
  const require = createRequire(import.meta.url)
  let pkgJsonPath
  try {
    pkgJsonPath = require.resolve(`${UPSTREAM_PKG}/package.json`)
  } catch (e) {
    fail(`상류 패키지 ${UPSTREAM_PKG} 를 못 찾음 — npm install 단계가 실패했거나 빠졌다(${e.code ?? e.message})`)
  }
  const version = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    fail(`상류 패키지 버전 문자열 이상: ${JSON.stringify(version)}`)
  }

  let ns
  try {
    ns = await import(`${UPSTREAM_PKG}/all`)
  } catch (e) {
    fail(`상류 ${UPSTREAM_PKG}/all 을 못 읽음 — 상류가 패키지 경로·형식을 바꿨을 수 있다(버전 ${version}): ${e.message}`)
  }
  const years = {}
  for (const [key, value] of Object.entries(ns)) {
    const m = /^y(\d{4})$/.exec(key)
    if (!m || Number(m[1]) < WINDOW_FLOOR_YEAR) continue
    if (!isPlainObject(value)) fail(`상류 연도표 ${key} 가 객체가 아님(버전 ${version}) — 상류 형식 변경`)
    const t = {}
    for (const [date, names] of Object.entries(value)) {
      if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
        fail(`상류 ${key}["${date}"] 이름 배열 형식 불량(버전 ${version}) — 상류 형식 변경`)
      }
      t[date] = [...names]
    }
    years[m[1]] = t
  }
  if (Object.keys(years).length === 0) {
    fail(`상류에서 ${WINDOW_FLOOR_YEAR}년 이후 연도표를 하나도 못 읽음(버전 ${version}) — 내보내기 이름(y2026 …) 변경?`)
  }
  return { version, years, pkgJsonPath }
}

// ─────────────────────────────────────────────────────────── 생성 모드

async function build(opts) {
  const up = await loadUpstream()
  info(`상류 ${UPSTREAM_PKG} ${up.version} (${up.pkgJsonPath})`)
  const years = up.years

  const prev = readPrevious()
  const oldYears = prev ? prev.years : {}
  if (!prev) warn('직전 holidays.json 없음 — 첫 생성으로 본다(단조성 검사 생략)')

  // 연도 미삭제 — 상류가 떨어뜨린 연도(하한 이전 포함)도 직전 표에 있었으면 유지.
  for (const y of Object.keys(oldYears)) {
    if (!(y in years)) {
      // 하한 이전 해는 상류에 있어도 일부러 안 읽으므로 "없음" 이 정상(정보) — 하한 이후 해가 빠진 것만 경고.
      if (Number(y) < WINDOW_FLOOR_YEAR) info(`게시 창 하한 이전 연도 ${y} — 직전 표에서 그대로 유지`)
      else warn(`상류에 없는 연도 ${y} — 직전 표에서 그대로 유지`)
      years[y] = sortYearsLoose({ [y]: oldYears[y] })[y]
    }
  }

  // overrides — add 먼저(같은 날짜면 이름을 덧붙임, 중복 이름 무시), 그다음 remove(날짜 삭제). 앱 생성기와 같은 순서.
  const ov = readOverrides()
  for (const [date, names] of Object.entries(ov.add)) {
    const y = date.slice(0, 4)
    if (!isPlainObject(years[y])) years[y] = {}
    const existing = Array.isArray(years[y][date]) ? years[y][date] : []
    years[y][date] = [...existing, ...names.filter((n) => !existing.includes(n))]
  }
  for (const date of ov.remove) {
    const y = date.slice(0, 4)
    if (isPlainObject(years[y])) delete years[y][date]
  }

  // 상한 12년 — 넘으면 가장 오래된 연도부터 뺀다. 그 연도가 직전 표에 있었다면 바로 아래 날짜 단조성 판정이
  // "13번째 연도 예외"(경고 1줄 통과) 또는 중단(다른 삭제가 섞인 경우)을 낸다.
  const yearKeys = Object.keys(years).sort()
  if (yearKeys.length > MAX_YEARS) {
    const dropped = yearKeys.slice(0, yearKeys.length - MAX_YEARS)
    const msg = `연도 ${yearKeys.length}개 > 상한 ${MAX_YEARS} — 가장 오래된 ${dropped.join(', ')} 를 뺀다`
    if (dropped.some((y) => hasOwn(oldYears, y))) info(msg)
    else warn(msg)
    for (const y of dropped) delete years[y]
  }

  const newYearsDraft = sortYearsLoose(years)

  // 날짜 단조성(검증기 전에 — 연도가 통째로 줄어든 경우 "10건 미만" 보다 이 메시지가 원인을 바로 말해 준다).
  checkMissing(oldYears, newYearsDraft, ov.removeSet, opts.allowRemove)

  const source = `${UPSTREAM_PKG} ${up.version} + overrides(add ${Object.keys(ov.add).length}, remove ${ov.remove.length})`
  const draftBase = { version: 1, format: HOLIDAY_TABLE_FORMAT, source, years: newYearsDraft }
  const validationFail = (raw) =>
    fail(
      `새 표가 앱 검증기 규칙을 통과하지 못함 — ${explainInvalidTable(raw) ?? '원인 미상'}\n` +
        `   상류 형식 변경이거나 holidays.overrides.json 오타 — 위 경고와 overrides 를 확인`
    )
  const tentativeRaw = { ...draftBase, generated_at: nowKstIso() }
  const tentative = validateHolidayTable(tentativeRaw)
  if (tentative === null) validationFail(tentativeRaw)
  checkControlChars(tentative.years)

  const nameViolations = findNameViolations(oldYears, tentative.years, ov.removeSet, opts.allowRename)
  if (nameViolations.length > 0) failNames(nameViolations)

  // 안정성 — 정규화 후 years 가 직전과 같으면 직전 파일을 바이트 그대로 둔다(source 만 다른 경우 포함).
  const yearsUnchanged =
    prev !== null && JSON.stringify(normYearsLoose(oldYears)) === JSON.stringify(tentative.years)
  let generatedAt = tentative.generated_at
  if (yearsUnchanged) {
    const prevValid = validateHolidayTable(prev.raw)
    if (prevValid !== null && serialize(prev.raw) === prev.text) {
      setOutput('changed', 'false')
      console.log(summaryLine('unchanged', prevValid.years, up.version))
      return
    }
    // years 는 같은데 직전 파일이 정규 모양이 아니거나(손편집 흔적·첫 게시 시드) 검증 불통과 → 정규 모양으로 다시 쓴다.
    // 도장은 직전 것이 형식상 유효하면 **그대로**(내용이 같으므로 — 그럴듯함 ① 이 이를 강제), 무효면 지금.
    warn('years 는 직전과 같지만 직전 파일이 정규 직렬화와 다르거나 검증 불통과 — 도장 유지, 정규 모양으로 다시 쓴다')
    if (parseGeneratedAt(prev.raw.generated_at) !== null) generatedAt = prev.raw.generated_at
  }

  const finalRaw = { ...draftBase, generated_at: generatedAt }
  const validated = validateHolidayTable(finalRaw)
  if (validated === null) validationFail(finalRaw)
  const text = serialize(validated)
  if (text.length > MAX_FEED_CHARS) fail(`새 표가 ${text.length}자 > 앱 상한 ${MAX_FEED_CHARS}자 — 앱이 파일 전체를 버린다`)
  checkPlausibility(prev, oldYears, validated, opts)

  const changes = describeChanges(oldYears, validated.years)
  for (const line of changes) info(line)
  writeAndReadBack(text)
  fs.writeFileSync(MSG_FILE, commitMessage(validated.generated_at, up.version, changes))
  setOutput('changed', 'true')
  console.log(summaryLine('changed', validated.years, up.version))
}

// ─────────────────────────────────────────────────────────── 검증 모드(쓰기 권한 잡)

function verify(opts) {
  const candPath = opts.verifyPath
  if (!fs.existsSync(candPath)) fail(`후보 파일 없음: ${candPath}`)
  const candText = fs.readFileSync(candPath, 'utf8')
  const cand = parseHolidayFeedText(candText)
  if (cand === null) {
    let why = candText.length > MAX_FEED_CHARS ? `${candText.length}자 > ${MAX_FEED_CHARS}자` : 'JSON 파손'
    try {
      why = explainInvalidTable(JSON.parse(candText)) ?? why
    } catch {
      /* JSON 파손 — why 그대로 */
    }
    fail(`후보 표가 앱 검증기를 통과하지 못함 — ${why}. 게시하지 않는다`)
  }
  checkControlChars(cand.years)
  if (serialize(cand) !== candText) {
    fail('후보 표가 정규 직렬화와 바이트가 다름 — 이 생성기가 만든 파일이 아니거나 변조됨. 게시하지 않는다')
  }
  const sm = SOURCE_RE.exec(cand.source)
  if (!sm) fail(`후보 source 모양이 이 생성기의 것이 아님: ${JSON.stringify(cand.source)}`)
  const version = sm[1]

  const ov = readOverrides()
  const prev = readPrevious()
  const oldYears = prev ? prev.years : {}

  // overrides 교차검증(2차 리뷰 🟡-3) — 후보가 **이 체크아웃의** overrides 로 만들어졌는가.
  //   (a) source 의 add/remove 건수 == 실제 overrides 건수   (b) remove 날짜가 후보에 남아 있지 않음
  const addCount = Object.keys(ov.add).length
  const removeCount = ov.remove.length
  if (Number(sm[2]) !== addCount || Number(sm[3]) !== removeCount) {
    fail(
      `후보 source 의 overrides 건수(add ${sm[2]}, remove ${sm[3]})가 이 저장소의 holidays.overrides.json ` +
        `(add ${addCount}, remove ${removeCount})과 다름 — 다른 overrides 로 만든 후보이거나 변조됨. 게시하지 않는다`
    )
  }
  const leftovers = ov.remove.filter((d) => hasOwn(cand.years[d.slice(0, 4)], d))
  if (leftovers.length > 0) {
    fail(`overrides.remove 의 날짜가 후보에 남아 있음: ${leftovers.join(', ')} — 회수가 반영되지 않은 후보. 게시하지 않는다`)
  }

  checkMissing(oldYears, cand.years, ov.removeSet, opts.allowRemove)
  const nameViolations = findNameViolations(oldYears, cand.years, ov.removeSet, opts.allowRename)
  if (nameViolations.length > 0) failNames(nameViolations)

  // overrides.add 가 후보에 실제로 반영됐는가(remove 가 이기는 날짜는 제외).
  const lostAdds = []
  for (const [date, names] of Object.entries(ov.add)) {
    if (ov.removeSet.has(date)) continue
    const have = cand.years[date.slice(0, 4)]?.[date]
    const want = names.map((n) => stripInvisible(n).trim())
    if (!Array.isArray(have) || want.some((n) => !have.includes(n))) lostAdds.push(`${date} ${JSON.stringify(names)}`)
  }
  if (lostAdds.length > 0) fail(`overrides.add 가 후보에 빠져 있음:\n${lostAdds.map((s) => `   - ${s}`).join('\n')}`)

  if (prev && prev.text === candText) {
    setOutput('changed', 'false')
    console.log(summaryLine('unchanged', cand.years, version))
    return
  }
  checkPlausibility(prev, oldYears, cand, opts)

  const changes = describeChanges(oldYears, cand.years)
  for (const line of changes) info(line)
  writeAndReadBack(candText)
  fs.writeFileSync(MSG_FILE, commitMessage(cand.generated_at, version, changes))
  setOutput('changed', 'true')
  console.log(summaryLine('changed', cand.years, version))
}

// ─────────────────────────────────────────────────────────── 진입

function parseArgs(args) {
  const opts = { allowRemove: false, allowRename: false, allowBulk: false, verifyPath: null }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--allow-remove') opts.allowRemove = true
    else if (a === '--allow-rename') opts.allowRename = true
    else if (a === '--allow-bulk') opts.allowBulk = true
    else if (a === '--verify') {
      const p = args[++i]
      if (!p || p.startsWith('--')) fail('--verify 뒤에 후보 파일 경로가 필요')
      opts.verifyPath = path.resolve(p)
    } else fail(`모르는 인자: ${a} (허용: --allow-remove, --allow-rename, --allow-bulk, --verify <파일>)`)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.allowRemove) warn('--allow-remove: 이번 실행에 한해 날짜 삭제를 허용한다')
if (opts.allowRename) warn('--allow-rename: 이번 실행에 한해 이름 변경·첫 이름 교체를 허용한다')
if (opts.allowBulk) warn('--allow-bulk: 이번 실행에 한해 늘어나는 양 상한(새 연도·새 날짜·이름 추가)을 풀어 준다')
fs.rmSync(MSG_FILE, { force: true }) // 지난 실행의 메시지가 남아 엉뚱한 커밋에 붙지 않게
try {
  if (opts.verifyPath) verify(opts)
  else await build(opts)
} catch (e) {
  fail(`예상 못 한 오류: ${e && e.stack ? e.stack : e}`)
}
