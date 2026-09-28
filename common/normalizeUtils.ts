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

// どの学部にもある講義情報。学部ごとの型はこれに項目を足して作る
export type BaseCourse = {
  code: string;
  systemIds: string[];
  level: '学部' | '大学院' | null;
  term: string;
  subject: string;
  instructor: string;
  classroomCode: string | null;
};

export const JAPANESE = /[぀-ヿ一-鿿]/; // ひらがな, カタカナ, 漢字の文字コード領域

// 全角英数・全角スペースを半角にし、連続空白を1つにまとめる
export function clean(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/*
(value ?? '') ： ヌル合体演算子
??をNullish Coalescing（ヌル合体）演算子という
valueがundefinedやnullの場合にエラーで落ちないよう空文字''に置き換える

.normalize('NFKC') : 全角半角の統一

.replace(/\s+/g, ' ') ：連続する空白を1つに縮める
\s ：スペース、タブ、改行などの「空白文字」全般
+ ：直前の文字が「1文字以上連続している」こと
g ：該当する場所をすべて（Globalに）置換するフラグ
具体例 : "A   B\n\t C" のようにスペースや改行が連なっている部分をすべて半角スペース1個（"A B C"）にまとめる

.trim() ： 端っこの空白を削る
具体例 : 文字列の先頭と末尾にある不要な空白を取り除く（"  ABC " → "ABC"）。
*/

// 全角英数・全角スペースを半角にし、連続空白を取り除く
export function normalizeHeader(header: string): string {
  return header.normalize('NFKC').replace(/\s+/g, '');
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
export function mergeByCode<T extends BaseCourse>(
  courses: T[],
  warnings: Warning[],
): T[] {
  const merged = new Map<string, T>(); // 講義コード -> 講義情報 の辞書
  for (const course of courses) {
    const existing = merged.get(course.code); // すでに同じ講義コードが登録されているか
    if (existing === undefined) {
      // 初めて出てきた講義コードならコピーして登録
      merged.set(course.code, { ...course });
      continue; // 次のcourseへ
    }
    existing.systemIds = Array.from(
      new Set([...existing.systemIds, ...course.systemIds]),
    ); // 系のリストを合体して重複を消す 例 : ['A'] + ['B'] -> ['A', 'B']
    for (const key of [
      'term',
      'subject',
      'instructor',
      'classroomCode',
    ] as const) {
      if (existing[key] === null || existing[key] === '') {
        // 先に登録された方が空なら後から来た方の値で埋める
        (existing[key] as string | null) = course[key];
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
  return Array.from(merged.values()); // Mapの値だけを取り出して配列にする
  /*
  new Map<string, T>() : キーと値のペアを持つ辞書
  .set(key, value) : 登録
  .get(key) : 取り出し。なければundefined
  .values() : 値だけを順番に取り出す(配列ではないのでArray.fromで配列にする)

  { ...course } : スプレッド構文
  ... はオブジェクトや配列の中身を展開する
  { ...course } はcourseの中身をコピーした新しいオブジェクトを作る
  コピーしないと、あとでexistingを書き換えたときに元のcourseまで書き換わってしまう
  例 : [...['A'], ...['B']] -> ['A', 'B']

  as const : 配列を「'term' | 'subject' | 'instructor' | 'classroomCode'」の型として扱わせる
  これがないとkeyがただのstringになり、existing[key]でエラーになる

  (existing[key] as string | null) = course[key]
  keyによって型が違う(classroomCodeだけnullあり)ので、TypeScriptに「string | nullとして代入していいよ」と教えている

  <T extends BaseCourse> : TはBaseCourseの項目を全部持っている型ならなんでもいい
  EngineeringCourseでもLawCourseでも使えて、返り値も渡した型のまま返ってくる
  */
}

// コマンドラインから実行したときの処理。入力JSONを読んで正規化し、結果を書き出す
export function runCli<T>(
  normalize: (tables: RawTable[]) => { courses: T[]; warnings: Warning[] },
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

  const tables: RawTable[] = JSON.parse(fs.readFileSync(inputPath, 'utf-8')); // ファイルを文字列として読み込み、JSONとしてオブジェクトに変換
  const result = normalize(tables);

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
  */
}
