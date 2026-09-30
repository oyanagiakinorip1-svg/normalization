import {
  BaseCourse,
  JAPANESE,
  RawTable,
  Warning,
  clean,
  createWarn,
  mapColumns,
  parseTerm,
  readCode,
  parseSchedule,
  runCli,
  yearFromLabel,
} from '../common/normalizeUtils';

type Field =
  | 'code' // 講義コード
  | 'level' // 大学院・学部
  | 'term' // 開講
  | 'subject' // 科目名
  | 'subjectEnglish' // 科目名（英字）
  | 'instructor' // 担当教員名
  | 'classroomCode' // Classroomのクラスコード
  | 'schedule'; // 開講曜日・講時(commonにのみある)

// 工学部の講義。項目は全学部共通(BaseCourse)
export type EngineeringCourse = BaseCourse;
/*
A & B : 交差型
AとBの項目を全部持つ型になる
例 : { code: string } & { isIntensive: boolean } -> { code: string; isIntensive: boolean }
*/

// 空白を除去してNFKCをかけたヘッダー名 -> フィールド
const HEADER_ALIASES: Record<string, Field> = {
  授業コード: 'code',
  講義コード: 'code',
  '大学院・学部': 'level',
  開講: 'term',
  科目名: 'subject',
  '科目名(英字)': 'subjectEnglish',
  担当教員名: 'instructor',
  Classroomのクラスコード: 'classroomCode',
  '開講曜日・講時': 'schedule',
};

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 頭がアルファベット２文字で1つ以上の数字が続くとういう正規表現

// 学部・大学院のvalueを取り出す
function parseLevel(value: string): EngineeringCourse['level'] {
  if (value === '学部' || value === '大学院') return value;
  return null;
}

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings, 'engineering'); // 警告用の関数(common/normalizeUtils.ts)
  const columns = mapColumns(
    table.headers,
    HEADER_ALIASES,
    [],
    ['code', 'term', 'subject', 'instructor'],
    warn,
  ); // ヘッダーから「どのフィールドが何列目か」の辞書を作る。必須列がなければ警告

  const courses: EngineeringCourse[] = [];
  table.rows.forEach((row, rowIndex) => {
    const get = (field: Field) =>
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
    ); // 講義コードを読み取る。取れなければcodeはnull、labelは警告メッセージ用(コードがなければ科目名)
    /*
    columns[field]! : 非nullアサーション
    ! をつけると「ここはundefinedじゃないよ」とTypeScriptに教えられる
    直前でundefinedかどうかを確認しているのでここではつけても大丈夫

    get('code') : 例えばcolumns.codeが0ならrow[0]をcleanして返す。列がなければ''
    */

    const termText = get('term').replace(/\s/g, ''); // 開講の空白をすべて消す 例 : "前期 集中" -> "前期集中"
    const term = parseTerm(termText, label, (message) =>
      warn(rowIndex, message),
    ); // 開講を前期・後期・通年にそろえる 例 : "前期集中" -> "前期"
    const instructor = get('instructor'); // 担当教員名を取り出す
    const schedule = get('schedule'); // 開講曜日・講時を取り出す(commonにしかないので他の系では'')

    const cellIndexes =
      columns.schedule === undefined ? null : parseSchedule(schedule); // schedule列がないテーブルはnull、ある場合はparseScheduleでcellIndexesに変換
    if (columns.schedule !== undefined && cellIndexes === null) {
      // schedule列はあるのに解釈できなかった場合は警告
      warn(
        rowIndex,
        `${label}: 開講曜日・講時「${schedule}」を解釈できません（列ずれの可能性）`,
      );
    }
    if (instructor !== '' && !JAPANESE.test(instructor)) {
      // 担当教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${label}: 担当教員名「${instructor}」に日本語が含まれません（列ずれの可能性）`,
      );
    }
    /*
    JAPANESE.test(instructor) : 正規表現にマッチするかどうかをtrue/falseで返す
    例 : JAPANESE.test('山田太郎') -> true, JAPANESE.test('0120') -> false
    ! : 否定。trueとfalseをひっくり返す
    */

    const level = parseLevel(get('level')); // '学部'か'大学院'ならそのまま、それ以外はnull
    if (columns.level !== undefined && level === null) {
      // level列はあるのに想定外の値だった場合は警告
      warn(rowIndex, `${label}: 大学院・学部「${get('level')}」が想定外です`);
    }

    // 1行分の講義情報をEngineeringCourseの形にしてcoursesに追加
    courses.push({
      code, // code: code の省略形
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      year: yearFromLabel(table.label), // 工学部のデータには年度の列がないので、ラベルの「〇〇〇〇年度」から。なければnull
      faculty: 'engineering',
      systemId: table.systemId, // 掲載元の系
      level,
      term,
      semesters: [], // 工学部のデータには対象学年やセメスターがない
      isIntensive: termText.includes('集中'), // 開講に「集中」が含まれていれば集中講義
      subject: get('subject'),
      subjectEnglish: get('subjectEnglish') || null, // 空文字''ならnull
      instructor,
      classroomCode: get('classroomCode') || null, // 空文字''ならnull
      place: null, // 工学部のデータには教室がない
      grades: null, // 工学部のデータには対象学年がない
      cellIndexes,
    });
    /*
    { code } : ショートハンドプロパティ
    変数名とプロパティ名が同じときは { code: code } を { code } と省略できる

    A || B : 論理和演算子
    Aがfalsy(''、0、null、undefinedなど)ならBを返す
    例 : '' || null -> null, 'ABC' || null -> 'ABC'
    ??との違い : ??はnullとundefinedのときだけBになるが、||は空文字''でもBになる
    */
  });
  return courses;
}

// 全テーブルを正規化して、講義の一覧と警告を返す(同じ講義コードでもまとめない)
export function normalizeEngineering(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses, warnings };
  /*
  .flatMap() : mapしたあとに1段階だけ平らにする
  normalizeTableは配列を返すので、mapだと配列の配列になってしまう
  例 : map -> [[A, B], [C]]
       flatMap -> [A, B, C]
  */
}

runCli(normalizeEngineering, __dirname, 'mock.json');
