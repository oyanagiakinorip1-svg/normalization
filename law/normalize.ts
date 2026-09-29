import {
  BaseCourse,
  JAPANESE,
  RawTable,
  Warning,
  clean,
  createWarn,
  mapColumns,
  mergeByCode,
  parseTerm,
  readCode,
  runCli,
} from '../common/normalizeUtils';

type LawField =
  | 'code' // 講義コード
  | 'term' // 講義期間
  | 'subject' // 講義名称
  | 'level' // 学部／研究科
  | 'instructor' // 成績担当教員
  | 'classroomCode'; // クラスコード

// 法学部は今のところBaseCourseにない項目がないのでそのまま使う
export type LawCourse = BaseCourse;

// 空白を除去してNFKCをかけたヘッダー名 -> フィールド
const HEADER_ALIASES: Record<string, LawField> = {
  講義コード: 'code',
  講義期間: 'term',
  講義名称: 'subject',
  '学部/研究科': 'level', // 「／」(全角)はNFKCで「/」(半角)になる
  成績担当教員: 'instructor',
  クラスコード: 'classroomCode',
};

// 使わない列。未知のヘッダーの警告を出さないようにする
const IGNORED_HEADERS = [
  '履修年度',
  'クラスルームの作成状況',
  'アクティブ/アーカイブ',
  '', // 見出しが空の列(注記が入っている)
];

// 「学部／研究科」の値 -> level
const LEVEL_ALIASES: Record<string, LawCourse['level']> = {
  法学部: '学部',
  法学研究科: '大学院',
};

const CODE_PATTERN = /^[A-Z]{2}\d+[A-Z]*$/; // 頭がアルファベット２文字で1つ以上の数字が続き、後ろに英字が付いてもいい 例 : JB99999, JM99999KR

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings); // 警告用の関数(common/normalizeUtils.ts)
  const columns = mapColumns(
    table.headers,
    HEADER_ALIASES,
    IGNORED_HEADERS,
    ['code', 'term', 'subject', 'instructor'],
    warn,
  ); // ヘッダーから「どのフィールドが何列目か」の辞書を作る。必須列がなければ警告

  const courses: LawCourse[] = [];
  table.rows.forEach((row, rowIndex) => {
    const get = (field: LawField) =>
      // 指定したフィールド名を渡すと正しいセルから値を取り出し余計な空白などを弾いて返す
      columns[field] === undefined ? '' : clean(row[columns[field]!]);

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
      (message) => warn(rowIndex, message),
    ); // 講義コードを読み取る。取れなければcodeはnull、labelは警告メッセージ用(コードがなければ講義名称)

    const instructor = get('instructor'); // 成績担当教員を取り出す
    if (instructor !== '' && !JAPANESE.test(instructor)) {
      // 担当教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${label}: 成績担当教員「${instructor}」に日本語が含まれません（列ずれの可能性）`,
      );
    }

    const level = LEVEL_ALIASES[get('level')] ?? null; // 「法学部」なら'学部'、「法学研究科」なら'大学院'、それ以外はnull
    if (columns.level !== undefined && level === null) {
      // level列はあるのに想定外の値だった場合は警告
      warn(rowIndex, `${label}: 学部／研究科「${get('level')}」が想定外です`);
    }

    // 1行分の講義情報をLawCourseの形にしてcoursesに追加
    courses.push({
      code,
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      systemIds: [table.systemId],
      level,
      term: parseTerm(get('term'), label, (message) => warn(rowIndex, message)), // 講義期間を前期・後期・通年にそろえる
      semester: null, // 法学部のデータにはセメスターがない
      subject: get('subject'),
      instructor,
      classroomCode: get('classroomCode') || null, // 空文字''ならnull
    });
  });
  return courses;
}

// 全テーブルを正規化して、講義コードでまとめたものと警告を返す
export function normalizeLaw(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses: mergeByCode(courses, warnings), warnings };
}

runCli(normalizeLaw, __dirname, 'mock.json');
