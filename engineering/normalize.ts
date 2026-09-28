import {
  BaseCourse,
  JAPANESE,
  RawTable,
  Warning,
  clean,
  createWarn,
  mapColumns,
  mergeByCode,
  runCli,
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

// BaseCourseに工学部だけの項目を足した型
export type EngineeringCourse = BaseCourse & {
  isIntensive: boolean;
  subjectEnglish: string | null;
  // Syllabus.cellIndexes と同じ採番: (講時 - 1) * 7 + 曜日(月=0)
  cellIndexes: number[] | null;
};
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

const DAYS = ['月', '火', '水', '木', '金', '土', '日'];
const MAX_PERIOD = 7;

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 頭がアルファベット２文字で1つ以上の数字が続くとういう正規表現

// 学部・大学院のvalueを取り出す
function parseLevel(value: string): EngineeringCourse['level'] {
  if (value === '学部' || value === '大学院') return value;
  return null;
}

// 「月1」「月1,水3」「月1・2」のような表記をcellIndexesに変換する。解釈できなければnull
function parseSchedule(value: string): number[] | null {
  const text = value
    .replace(/\s/g, '') // スペース, タブ, 改行を取り除く
    .replace(/講時|限/g, ''); // 例 : 月1限 -> 月1
  if (text === '' || text.includes('集中')) return []; // テキストが空または集中講義の場合は特定の曜日・コマを持たないためnullではなく空配列[]を返して正常終了

  const indexes: number[] = [];
  const groups = text.match(/[月火水木金土日][\d・,、-]+/g); // 例 : "月1,3水2-4" → ["月1,3", "水2-4"] & \d : 数字
  if (groups === null || groups.join('') !== text) return null; // 解釈不能な文字(例 : "月1（仮）")などが含まれる場合はnullを返す
  for (const group of groups) {
    const day = DAYS.indexOf(group[0]); // 曜日をDAYSのindexの基づき数値化
    const body = group.slice(1).replace(/[,、]+$/, ''); // groupの先頭の１文字(曜日)と末尾の,や、を取り除く 例 : "月1,3," $\rightarrow$ "1,3"
    const periods = body.match(/\d+/g) ?? []; // bodyから全ての数字を取り出して配列にする 例 ： "1,3" -> ["1", "3"] 数字が見つからなければ[]を返す

    const range = body.match(/^(\d+)-(\d+)$/);
    /*
    body.match(/^(\d+)-(\d+)$/) : 範囲指定かどうかを判別
    bodyが"1-3"の場合（成功） : rangeには次のような配列が入る
      range[0] -> "1-3"（全体）
      range[1] -> "1"（1つ目のカッコ：開始の時限）
      range[2] -> "3"（2つ目のカッコ：終了の時限）
    bodyが"1,3"や"1・2"の場合（失敗） : ハイフン形式に一致しないためrangeはnullになる
    */

    const expanded = range // 時限の数字をリスト化
      ? Array.from(
          { length: Number(range[2]) - Number(range[1]) + 1 },
          (_, i) => Number(range[1]) + i,
        )
      : periods.map(Number);
    /*
    Number : string -> number

    Array.from() : 配列っぽいものから本物の配列を作る
    例 : 文字列から配列を作る Array.from('hello') -> ['h', 'e', 'l', 'l', 'o']
    
    Array.from({ length: 3 }) : 配列の長さを指定する
    例 : Array.from({ length: 3 }) -> [undefined, undefined, undefined]
    
    (_, i) : マップ関数
    (value, index)が引数となる
      _ : 「第1引数の値は使わない」というプログラマーの慣習的な記号。別にvでもいいのに
      i : 0から始まるカウントアップ数字（1マス目は0、2マス目は1、3マス目は2）
    */

    for (const period of expanded) {
      if (period < 1 || period > MAX_PERIOD) return null; // 時限が例外な数値だった場合はnullを返す
      indexes.push((period - 1) * 7 + day); // indexesにcellIndexを計算して格納
    }
  }
  return Array.from(new Set(indexes)).sort((a, b) => a - b); // 重複を消し、並びを整える
  /*
  new Set(indexes) : 重複を消す
  Setは同じ値を重複して持てないJavaScriptのコレクション。配列をSetに放り込むだけで、かぶっている数字が消える
  例 : [16, 0, 16] -> Set { 16, 0 }

  // リテラルで作れるもの（newがいらない）
  const arr = [];      // 配列
  const obj = {};      // オブジェクト

  // 記号がないので new が必要なもの (インスタンス化)
  const set = new Set();     // 重複のない集合
  const map = new Map();     // 連想配列（マップ）
  const date = new Date();   // 日付データ

  .sort((a, b) => a-b) : 並べ替え
  sort()は配列から2つの要素aとbを取り出して比較するとき関数が返した数値によって以下のように並び替える
  マイナスを返したら -> aを前に置く
  プラスを返したら -> b を前に置く
  0 を返したら -> 順番を変えない
  */
}

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings); // 警告用の関数(common/normalizeUtils.ts)
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

    const code = get('code').replace(/\s/g, '').toUpperCase(); // 講義コードの空白をすべて消して大文字に統一
    if (!CODE_PATTERN.test(code)) {
      // 不正なコードの排除
      warn(
        rowIndex,
        `講義コード「${code}」の形式が想定外のためスキップしました`,
      );
      return;
    }
    /*
    columns[field]! : 非nullアサーション
    ! をつけると「ここはundefinedじゃないよ」とTypeScriptに教えられる
    直前でundefinedかどうかを確認しているのでここではつけても大丈夫

    get('code') : 例えばcolumns.codeが0ならrow[0]をcleanして返す。列がなければ''

    .toUpperCase() : 小文字を大文字にする 例 : "ab123" -> "AB123"

    forEachの中のreturn : forEachでは関数を抜けるのではなく「この行の処理をやめて次の行へ」という意味になる(forのcontinueと同じ)
    */

    const term = get('term').replace(/\s/g, ''); // 開講の空白をすべて消す 例 : "前期 集中" -> "前期集中"
    const instructor = get('instructor'); // 担当教員名を取り出す
    const schedule = get('schedule'); // 開講曜日・講時を取り出す(commonにしかないので他の系では'')

    const cellIndexes =
      columns.schedule === undefined ? null : parseSchedule(schedule); // schedule列がないテーブルはnull、ある場合はparseScheduleでcellIndexesに変換
    if (columns.schedule !== undefined && cellIndexes === null) {
      // schedule列はあるのに解釈できなかった場合は警告
      warn(
        rowIndex,
        `${code}: 開講曜日・講時「${schedule}」を解釈できません（列ずれの可能性）`,
      );
    }
    if (instructor !== '' && !JAPANESE.test(instructor)) {
      // 担当教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${code}: 担当教員名「${instructor}」に日本語が含まれません（列ずれの可能性）`,
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
      warn(rowIndex, `${code}: 大学院・学部「${get('level')}」が想定外です`);
    }

    // 1行分の講義情報をEngineeringCourseの形にしてcoursesに追加
    courses.push({
      code, // code: code の省略形
      systemIds: [table.systemId], // この時点では1つの系だけ。mergeByCodeで他の系とまとめる
      level,
      term,
      isIntensive: term.includes('集中'), // 開講に「集中」が含まれていれば集中講義
      subject: get('subject'),
      subjectEnglish: get('subjectEnglish') || null, // 空文字''ならnull
      instructor,
      classroomCode: get('classroomCode') || null, // 空文字''ならnull
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

// 全テーブルを正規化して、講義コードでまとめたものと警告を返す
export function normalizeEngineering(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses: mergeByCode(courses, warnings), warnings };
  /*
  .flatMap() : mapしたあとに1段階だけ平らにする
  normalizeTableは配列を返すので、mapだと配列の配列になってしまう
  例 : map -> [[A, B], [C]]
       flatMap -> [A, B, C]
  */
}

runCli(normalizeEngineering, __dirname, 'engineering.json');
