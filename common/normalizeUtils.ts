import * as fs from 'fs';
import * as path from 'path';

// スクレイパーの出力
export type RawTable = {
  systemId: string;
  label: string;
  tableIndex: number;
  headers: string[];
  rows: string[][];
};

export type Warning = {
  systemId: string;
  tableIndex: number;
  row: number | null;
  message: string;
};

// 講義コードが取れたかどうか
// matched : 講義コードが取れた
// unmatched : 講義コードがない、または形式が想定外(codeはnull)
// ambiguous : 講義コードの候補が複数あって1つに決められない(codeはnull。農学部のみ)
// not-offered : 不開講(codeとclassroomCodeはnull。農学部のみ)
//   これだけ講義コードの話ではなく「その年は講義が開かれない」という意味
//   農学部の元データのstatusをそのまま引き継いでいる(元データではクラスコードの欄に「不開講」と書かれている)
export type CourseStatus =
  'matched' | 'unmatched' | 'ambiguous' | 'not-offered';

// 開講時期
export type Term = '前期' | '後期' | '通年';

// どの学部にもある講義情報。学部ごとの型はこれに項目を足して作る
export type BaseCourse = {
  code: string | null; // 講義コードが取れなかったらnull(仮のコードは入れない)
  status: CourseStatus;
  systemIds: string[];
  level: '学部' | '大学院' | null;
  term: Term | null; // 前期・後期・通年。わからなければnull
  semester: number | null; // セメスター番号(1以上。6年制の学部なら12まである)。わからなければnull
  subject: string;
  instructor: string;
  classroomCode: string | null;
};

export const JAPANESE = /[぀-ヿ一-鿿]/; // ひらがな, カタカナ, 漢字の文字コード領域

// 全角英数字を半角にし、連続空白(全角スペースも含む)を1つにまとめる
export function clean(value: string | undefined): string {
  return toHalfWidth(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
(value ?? '') ： ヌル合体演算子
??をNullish Coalescing（ヌル合体）演算子という
valueがundefinedやnullの場合にエラーで落ちないよう空文字''に置き換える

toHalfWidth() : 全角英数字だけ半角にする(下のtoHalfWidthを参照)
「Ⅰ」「①」「（）」などはwebAppのデータに合わせてそのまま残す

.replace(/\s+/g, ' ') ：連続する空白を1つに縮める
\s ：スペース、タブ、改行などの「空白文字」全般
+ ：直前の文字が「1文字以上連続している」こと
g ：該当する場所をすべて（Globalに）置換するフラグ
具体例 : "A   B\n\t C" のようにスペースや改行が連なっている部分をすべて半角スペース1個（"A B C"）にまとめる

.trim() ： 端っこの空白を削る
具体例 : 文字列の先頭と末尾にある不要な空白を取り除く（"  ABC " → "ABC"）。
*/

// 全角英数字(Ａ-Ｚ, ａ-ｚ, ０-９)だけを半角にする。webAppの検索と同じ変換
export function toHalfWidth(value: string): string {
  return value.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0),
  );
  /*
  s.charCodeAt(0) : 文字の文字コード(番号)を取り出す
  全角英数字と半角英数字の文字コードはちょうど0xfee0だけずれているので、引くと半角になる
  例 : "Ａ"(0xff21) - 0xfee0 -> 0x41 -> "A"

  String.fromCharCode() : 文字コード -> 文字(charCodeAtの逆)

  .normalize('NFKC')を使わないのは、「Ⅰ」->「I」、「①」->「1」のように英数字以外まで変わってしまうため
  */
}

// ヘッダー名を比べやすくする。全角半角を統一して空白を取り除く(ヘッダーは値ではないのでNFKCで強めに統一する)
export function normalizeHeader(header: string): string {
  return header.normalize('NFKC').replace(/\s+/g, '');
}

const DAYS = ['月', '火', '水', '木', '金', '土', '日'];
const MAX_PERIOD = 7;

// 「月1」「月1,水3」「月1・2」のような表記をcellIndexesに変換する。解釈できなければnull
export function parseSchedule(value: string): number[] | null {
  const text = value
    .normalize('NFKC') // 読み取るだけなのでNFKCで強めに統一する 例 : "月１，３" -> "月1,3"
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

// 講義コードを読み取る。形式が想定外ならcodeをnullにして警告を出す
export function readCode(
  value: string, // 講義コードのセルの値
  pattern: RegExp, // 学部ごとの講義コードの形式
  subject: string, // 講義コードがないときに警告メッセージで代わりに表示する科目名
  warn: (message: string) => void,
): { code: string | null; label: string } {
  const rawCode = value.replace(/\s/g, '').toUpperCase(); // 講義コードの空白をすべて消して大文字に統一
  const code = pattern.test(rawCode) ? rawCode : null; // 形式が想定外ならnull
  const label = code ?? subject; // 警告メッセージ用。講義コードがなければ科目名で表示
  if (code === null) {
    // 講義コードが取れなかった行も捨てずにcode: nullで残す
    warn(
      rawCode === ''
        ? `${label}: 講義コードがないため code: null にしました`
        : `${label}: 講義コード「${rawCode}」の形式が想定外のため code: null にしました`,
    );
  }
  return { code, label };
  /*
  .toUpperCase() : 小文字を大文字にする 例 : "ab123" -> "AB123"

  code ?? subject : codeがnullなら科目名を使う

  返り値 { code, label } : 2つの値をまとめて返している
  呼ぶ側は const { code, label } = readCode(...) として取り出す(分割代入)
  */
}

// 開講時期の表記を'前期' / '後期' / '通年'にそろえる。そろえられなければnullにして警告を出す
// 元の文字のまま残さないのは、列ずれで別の列の値が入っていたときに、そのままDBまで流れてしまわないようにするため
// 例 : "前期集中" -> "前期", "後期前半" -> "後期", "第1学期" -> "前期"
export function parseTerm(
  value: string, // 開講時期のセルの値
  label: string, // 警告メッセージ用(講義コードか科目名)
  warn: (message: string) => void,
): Term | null {
  const text = value.replace(/\s/g, ''); // スペース, タブ, 改行を取り除く
  if (text === '') return null; // 開講時期の列がない、または空欄

  if (text.includes('通年')) return '通年';
  if (text.startsWith('前期') || text.includes('第1学期')) return '前期'; // 例 : "前期", "前期前半", "前期集中", "第1学期"
  if (text.startsWith('後期') || text.includes('第2学期')) return '後期'; // 例 : "後期", "後期前半", "後期集中", "第2学期"

  warn(
    `${label}: 開講時期「${value}」を解釈できないため term: null にしました`,
  );
  return null;
}

// セメスターの表記を数字にする。数字にできなければnullにして警告を出す
// webAppの時間割は1〜8セメスターだが、6年制の学部もあるのでここでは上限を決めない
// 例 : "5セメ" -> 5, "02" -> 2
export function parseSemester(
  value: string, // セメスターのセルの値
  label: string, // 警告メッセージ用(講義コードか科目名)
  warn: (message: string) => void,
): number | null {
  const text = value.replace(/\s/g, ''); // スペース, タブ, 改行を取り除く
  if (text === '') return null; // セメスターの列がない、または空欄

  const match = text.match(/^(\d{1,2})(セメ(スター)?)?$/);
  if (match !== null) {
    const semester = Number(match[1]);
    if (semester >= 1) return semester; // 0セメはないので1以上だけ
  }
  /*
  text.match(/^(\d{1,2})(セメ(スター)?)?$/) : セメスター番号の表記かどうかを判別
    \d{1,2} : 1〜2桁の数字
    (セメ(スター)?)? : 「セメ」「セメスター」が後ろに付いてもいいし、なくてもいい
  "5セメ"の場合 : match[1] -> "5"
  "02"の場合 : match[1] -> "02" -> Number("02") -> 2
  */

  warn(
    `${label}: セメスター「${value}」を解釈できないため semester: null にしました`,
  );
  return null;
}

// セメスター番号から前期・後期を決める。奇数なら前期、偶数なら後期。nullならnull
export function termFromSemester(semester: number | null): Term | null {
  if (semester === null) return null;
  return semester % 2 === 1 ? '前期' : '後期';
  /*
  semester % 2 : 2で割った余り。1なら奇数、0なら偶数
  */
}

// 警告用の関数を作る
export function createWarn(table: RawTable, warnings: Warning[]) {
  return (row: number | null, message: string) =>
    warnings.push({
      systemId: table.systemId, // どのシステムのデータか
      tableIndex: table.tableIndex, // 何番目のテーブルか
      row, // エラーの行
      message, // 警告メッセージ
    });
  /*
  (引数) => 処理 : アロー関数
  function warn(row, message) { return warnings.push(...) } と同じ意味
  {}を書かずに1行で書いた場合はその処理の結果がそのままreturnされる

  table.systemIdやtable.tableIndexは毎回同じなので、warnの中で埋めておけば呼ぶ側はrowとmessageだけ渡せばいい
  例 : warn(3, 'おかしい') -> { systemId: 'common', tableIndex: 0, row: 3, message: 'おかしい' } がwarningsに追加される

  createWarnは「warnという関数」を返す関数。学部ごとのnormalizeTableの最初で
  const warn = createWarn(table, warnings) として使う
  */
}

// ヘッダーを見て「どのフィールドが何列目か」の辞書を作る
export function mapColumns<F extends string>(
  headers: string[],
  aliases: Record<string, F>, // 空白を除去してNFKCをかけたヘッダー名 -> フィールド
  ignoredHeaders: string[], // 使わないとわかっているヘッダー(警告を出さない)
  requiredFields: readonly F[], // ないと困るフィールド
  warn: (row: number | null, message: string) => void,
): Partial<Record<F, number>> {
  const columns: Partial<Record<F, number>> = {}; // 辞書。Field名と科目のインデックスを紐づける
  headers.forEach((header, i) => {
    const name = normalizeHeader(header); // テーブルの各ヘッダー文字列を半角で整える
    const field = aliases[name];
    if (field !== undefined) {
      // 既知のヘッダーだった場合、対応するフィールド名に対してその列番号を記録
      columns[field] = i;
    } else if (!ignoredHeaders.includes(name)) {
      warn(null, `未知のヘッダー「${header}」を無視しました`);
    }
  });
  // 必須列があるかの確認
  for (const field of requiredFields) {
    if (columns[field] === undefined)
      warn(null, `必須列 ${field} がありません`);
  }
  return columns;
  /*
  Record<Field, number> : Fieldをキー、numberを値に持つオブジェクトの型
  Partial<...> : 全部のキーを「あってもなくてもいい」にする
  テーブルによって無い列もあるのでPartialにしている
  例 : { code: 0, term: 2, subject: 3 } // levelやscheduleが無くてもOK

  .forEach((header, i) => {...}) : 配列の要素を1つずつ取り出して処理する
    header : 要素の値
    i : 0から始まるインデックス(何列目か)

  `未知のヘッダー「${header}」` : テンプレートリテラル
  バッククォート` `で囲むと${}の中に変数を埋め込める

  ヘッダーが ['講義コード', '科目名', '担当教員名'] なら columns は { code: 0, subject: 1, instructor: 2 } になる

  <F extends string> : ジェネリクス
  Fは「呼ぶ側が決める型」。工学部ならFieldが、法学部ならLawFieldが入る
  extends string は「Fは文字列の型じゃないとダメ」という制限
  これで1つの関数を学部ごとに違うFieldで使い回せる
  */
}

// 同じ講義コードを1件にまとめる。値が食い違う項目は先勝ちで警告を出す
// codeがnullの講義は同じ講義か判断できないので、まとめずに1件ずつ残す
export function mergeByCode<T extends BaseCourse>(
  courses: T[],
  warnings: Warning[],
): T[] {
  const results: T[] = []; // 出力する講義のリスト(元の順番のまま)
  const merged = new Map<string, T>(); // 講義コード -> 講義情報 の辞書
  for (const course of courses) {
    if (course.code === null) {
      // 講義コードがない講義はそのまま残す
      results.push({ ...course });
      continue;
    }
    const existing = merged.get(course.code); // すでに同じ講義コードが登録されているか
    if (existing === undefined) {
      // 初めて出てきた講義コードならコピーして登録
      const copy = { ...course };
      merged.set(course.code, copy);
      results.push(copy);
      continue; // 次のcourseへ
    }
    existing.systemIds = Array.from(
      new Set([...existing.systemIds, ...course.systemIds]),
    ); // 系のリストを合体して重複を消す 例 : ['A'] + ['B'] -> ['A', 'B']
    for (const key of [
      'term',
      'semester',
      'subject',
      'instructor',
      'classroomCode',
    ] as const) {
      if (existing[key] === null || existing[key] === '') {
        // 先に登録された方が空なら後から来た方の値で埋める
        (existing[key] as string | number | null) = course[key];
      } else if (
        course[key] !== null &&
        course[key] !== '' &&
        existing[key] !== course[key]
      ) {
        // 両方に値があって食い違う場合は先に登録された方を採用して警告
        warnings.push({
          systemId: course.systemIds[0],
          tableIndex: -1, // 複数テーブルにまたがる警告なので特定のテーブルを指さない
          row: null,
          message: `${course.code}: ${key} が系によって異なります（「${existing[key]}」を採用、「${course[key]}」を破棄）`,
        });
      }
    }
  }
  return results;
  /*
  new Map<string, T>() : キーと値のペアを持つ辞書
  .set(key, value) : 登録
  .get(key) : 取り出し。なければundefined

  mergedとresultsには同じオブジェクト(copy)を入れている
  あとでexistingを書き換えると、resultsの中の講義も一緒に書き換わる
  resultsを別に持っているのは、codeがnullの講義も元の順番のまま並べるため

  { ...course } : スプレッド構文
  ... はオブジェクトや配列の中身を展開する
  { ...course } はcourseの中身をコピーした新しいオブジェクトを作る
  コピーしないと、あとでexistingを書き換えたときに元のcourseまで書き換わってしまう
  例 : [...['A'], ...['B']] -> ['A', 'B']

  as const : 配列を「'term' | 'semester' | 'subject' | 'instructor' | 'classroomCode'」の型として扱わせる
  これがないとkeyがただのstringになり、existing[key]でエラーになる

  (existing[key] as string | number | null) = course[key]
  keyによって型が違う(termとsemesterは数字、classroomCodeはnullあり)ので、TypeScriptに「string | number | nullとして代入していいよ」と教えている

  <T extends BaseCourse> : TはBaseCourseの項目を全部持っている型ならなんでもいい
  EngineeringCourseでもLawCourseでも使えて、返り値も渡した型のまま返ってくる
  */
}

// コマンドラインから実行したときの処理。入力JSONを読んで正規化し、結果を書き出す
export function runCli<Input, T>(
  normalize: (input: Input) => { courses: T[]; warnings: Warning[] }, // 入力の形は学部ごとに違ってもいい(農学部はRawTableではない)
  dir: string, // 呼び出し元のフォルダ(__dirnameを渡す)
  defaultInput: string, // 入力ファイルの指定がないときに読むファイル名
) {
  const inputPath = process.argv[2] ?? path.join(dir, defaultInput); // 入力ファイル。指定がなければ同じフォルダのdefaultInput
  const outputPath = process.argv[3] ?? path.join(dir, 'out.json'); // 出力ファイル。指定がなければ同じフォルダのout.json
  /*
  process.argv : コマンドライン引数の配列
  例 : normalize.ts a.json b.json として実行した場合
    process.argv[0] -> 実行しているプログラム(node)の場所
    process.argv[1] -> normalize.tsの場所
    process.argv[2] -> 'a.json'
    process.argv[3] -> 'b.json'

  __dirname : このファイルがあるフォルダのパス
  runCliの中で__dirnameを使うとcommonフォルダになってしまうので、呼び出し元から渡してもらう
  path.join() : OSに合わせてパスをつなげる 例 : path.join('data', 'mock.json') -> 'data/mock.json'
  */

  const input: Input = JSON.parse(fs.readFileSync(inputPath, 'utf-8')); // ファイルを文字列として読み込み、JSONとしてオブジェクトに変換
  const result = normalize(input);

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', 'utf-8'); // 結果をJSON文字列にしてファイルに書き出す
  console.log(`${result.courses.length} 件を正規化しました -> ${outputPath}`);
  for (const w of result.warnings) {
    // 警告を1件ずつ表示
    const at = w.row === null ? '' : ` row ${w.row}`; // 行番号がある警告だけ「row 3」のように表示
    console.warn(`[warn] ${w.systemId}${at}: ${w.message}`);
  }
  /*
  JSON.stringify(result, null, 2) : オブジェクト -> JSON文字列
    第2引数null : 変換ルールの指定(使わないのでnull)
    第3引数2 : インデントをスペース2つにして見やすくする
  JSON.parse() : JSON文字列 -> オブジェクト(stringifyの逆)

  normalize : 引数に関数を渡している。normalizeEngineeringやnormalizeLawが入る
  <Input, T> : Inputは入力JSONの型、Tは講義の型。どちらも渡したnormalizeから自動で決まる
  */
}
