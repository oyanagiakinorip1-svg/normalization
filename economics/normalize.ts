import {
  BaseCourse,
  JAPANESE,
  RawTable,
  Term,
  Warning,
  clean,
  createWarn,
  mapColumns,
  mergeByCode,
  normalizeHeader,
  parseSchedule,
  parseTerm,
  readCode,
  runCli,
  semestersFromGrades,
} from '../common/normalizeUtils';

type EconomicsField =
  | 'day' // 曜日 / Day
  | 'period' // 講時 / Period
  | 'code' // 講義コード / Code
  | 'subject' // 授業科目名 / Subject Name
  | 'grades' // 学年配当(学部のテーブルにだけある)
  | 'term' // 学期 / Session
  | 'place' // 講義室名 / 開講場所 / Venue
  | 'instructor'; // 担当教員 / Instructor

// BaseCourseに経済学部だけの項目を足した型
export type EconomicsCourse = BaseCourse & {
  place: string | null; // 教室(webAppのSyllabus.placeと同じ名前)
  grades: number[] | null; // 対象学年 例 : [2, 3, 4]。学年配当の列がなければnull
  // Syllabus.cellIndexes と同じ採番: (講時 - 1) * 7 + 曜日(月=0)
  cellIndexes: number[] | null;
};

// 空白を除去してNFKCをかけたヘッダー名 -> フィールド
// GPEMのテーブルはヘッダーが英語なので、英語のヘッダーも同じフィールドにそろえる
const HEADER_ALIASES: Record<string, EconomicsField> = {
  曜日: 'day',
  講時: 'period',
  講義コード: 'code',
  授業科目名: 'subject',
  学年配当: 'grades',
  学期: 'term',
  講義室名: 'place',
  開講場所: 'place',
  担当教員: 'instructor',
  Day: 'day',
  Period: 'period',
  Code: 'code',
  SubjectName: 'subject', // 「Subject Name」は空白が取り除かれて「SubjectName」になる
  Session: 'term',
  Venue: 'place',
  Instructor: 'instructor',
};

// 英語の曜日 -> 日本語の曜日
const DAY_ALIASES: Record<string, string> = {
  Mon: '月',
  Tue: '火',
  Wed: '水',
  Thu: '木',
  Fri: '金',
  Sat: '土',
  Sun: '日',
};

// NFKCをかけたローマ数字。indexに1を足すと数字になる 例 : 'III' -> 2 + 1 = 3
const ROMAN_NUMERALS = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
];

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 頭がアルファベット２文字で1つ以上の数字が続く 例 : EB999, EM9999

// ローマ数字を数字にする。ローマ数字でなければnull 例 : "Ⅲ" -> 3
function romanToNumber(value: string): number | null {
  const index = ROMAN_NUMERALS.indexOf(value.normalize('NFKC').toUpperCase());
  return index === -1 ? null : index + 1;
  /*
  .normalize('NFKC') : 「Ⅲ」(1文字のローマ数字)を「III」(アルファベット3文字)にする
  ROMAN_NUMERALS.indexOf(...) : 配列の何番目にあるか。なければ-1
  */
}

// 経済学部の学期の表記を前期・後期にそろえる
// 「Ⅰ」「Ⅱ」「Ⅲ」のようなローマ数字は、奇数なら前期、偶数なら後期
// 「Spring」は前期、「Fall」は後期。それ以外(「前期」など)はparseTermにまかせる
function parseEconomicsTerm(
  value: string,
  label: string,
  warn: (message: string) => void,
): Term | null {
  const number = romanToNumber(value);
  if (number !== null) return number % 2 === 1 ? '前期' : '後期';

  const text = value.toLowerCase(); // 大文字・小文字をそろえる 例 : "Fall" -> "fall"
  if (text === 'spring') return '前期';
  if (text === 'fall' || text === 'autumn') return '後期';

  return parseTerm(value, label, warn);
}

// 学年配当を数字の配列にする。学年配当の列がなければnull
// 例 : "2･3･4" -> [2, 3, 4], "1・2" -> [1, 2], "2～4" -> [2, 3, 4]
function parseGrades(
  value: string,
  label: string,
  warn: (message: string) => void,
): number[] | null {
  const text = value.replace(/\s/g, ''); // スペース, タブ, 改行を取り除く
  if (text === '') return null;

  const range = text.match(/^(\d+)[~～-](\d+)$/); // 範囲指定かどうか 例 : "2～4"
  if (range !== null) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }

  const grades = (text.match(/\d+/g) ?? []).map(Number); // 数字を全部取り出す 例 : "2･3･4" -> [2, 3, 4]
  if (grades.length === 0) {
    warn(
      `${label}: 学年配当「${value}」を解釈できないため grades: null にしました`,
    );
    return null;
  }
  return grades;
  /*
  範囲指定の書き方はparseScheduleのrangeと同じ
  Array.from({ length: 3 }, (_, i) => 2 + i) -> [2, 3, 4]
  */
}

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings); // 警告用の関数(common/normalizeUtils.ts)
  const columns = mapColumns(
    table.headers,
    HEADER_ALIASES,
    [],
    ['code', 'subject', 'instructor'],
    warn,
  ); // ヘッダーから「どのフィールドが何列目か」の辞書を作る。必須列がなければ警告

  // ラベルに「研究科」があれば大学院、「学部」があれば学部のテーブル
  // 例 : "経済学部・学部時間割" -> 学部, "経済学研究科・GPEM特論等" -> 大学院
  const level: EconomicsCourse['level'] = table.label.includes('研究科')
    ? '大学院'
    : table.label.includes('学部')
      ? '学部'
      : null;
  if (level === null)
    warn(null, `ラベル「${table.label}」から学部か大学院か判断できません`);

  // 教員の列の見出しが英語(Instructor)のテーブルは、教員名も英語なので日本語のチェックをしない
  const checkJapaneseInstructor =
    columns.instructor === undefined ||
    normalizeHeader(table.headers[columns.instructor]) !== 'Instructor';

  const courses: EconomicsCourse[] = [];
  table.rows.forEach((row, rowIndex) => {
    const get = (field: EconomicsField) =>
      // 指定したフィールド名を渡すと正しいセルから値を取り出し余計な空白などを弾いて返す
      columns[field] === undefined ? '' : clean(row[columns[field]!]);
    const onWarn = (message: string) => warn(rowIndex, message); // 各parse関数用の警告関数

    if (row.length !== table.headers.length) {
      // 列数のずれのチェック
      warn(
        rowIndex,
        `列数 ${row.length} がヘッダー数 ${table.headers.length} と一致しません`,
      );
    }

    const { code, label } = readCode(
      get('code'),
      CODE_PATTERN,
      get('subject'),
      onWarn,
    ); // 講義コードを読み取る。取れなければcodeはnull、labelは警告メッセージ用(コードがなければ科目名)

    const instructor = get('instructor'); // 担当教員を取り出す
    if (
      checkJapaneseInstructor &&
      instructor !== '' &&
      !JAPANESE.test(instructor)
    ) {
      // 担当教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${label}: 担当教員「${instructor}」に日本語が含まれません（列ずれの可能性）`,
      );
    }

    // 曜日と講時が別々の列なので、日本語の曜日と数字の講時にそろえてからparseScheduleにかける
    const day = DAY_ALIASES[get('day')] ?? get('day'); // 例 : "Wed" -> "水"
    const period = romanToNumber(get('period')) ?? get('period'); // 例 : "Ⅲ" -> 3
    const cellIndexes =
      columns.day === undefined || columns.period === undefined
        ? null
        : parseSchedule(`${day}${period}`); // 曜日・講時の列がないテーブルはnull。どちらも空欄なら[]
    if (cellIndexes === null && columns.day !== undefined) {
      // 曜日・講時の列はあるのに解釈できなかった場合は警告
      warn(
        rowIndex,
        `${label}: 曜日・講時「${get('day')} ${get('period')}」を解釈できません（列ずれの可能性）`,
      );
    }
    /*
    DAY_ALIASES[get('day')] ?? get('day') : 英語の曜日なら日本語に、それ以外(もともと日本語など)はそのまま
    romanToNumber(get('period')) ?? get('period') : ローマ数字なら数字に、それ以外(もともと数字など)はそのまま
    */

    const term = parseEconomicsTerm(get('term'), label, onWarn); // 学期を前期・後期にそろえる 例 : "Ⅰ" -> "前期", "Fall" -> "後期"
    const grades = parseGrades(get('grades'), label, onWarn); // 学年配当を数字の配列にする 例 : "２･３･４" -> [2, 3, 4]

    // 1行分の講義情報をEconomicsCourseの形にしてcoursesに追加
    courses.push({
      code,
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      year: null, // 経済学部のデータには年度がない
      systemIds: [table.systemId],
      level,
      term,
      semesters: semestersFromGrades(grades, term), // 学年配当と学期から計算する 例 : [2, 3, 4]と"前期" -> [3, 5, 7]。学年配当がない大学院のテーブルは[]
      subject: get('subject'),
      instructor,
      classroomCode: null, // 経済学部のデータにはClassroomのクラスコードがない
      place: get('place') || null, // 空文字''ならnull
      grades,
      cellIndexes,
    });
  });
  return courses;
}

// 全テーブルを正規化して、講義コードでまとめたものと警告を返す
export function normalizeEconomics(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses: mergeByCode(courses, warnings), warnings };
}

runCli(normalizeEconomics, __dirname, 'mock.json');
