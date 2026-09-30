import {
  BaseCourse,
  JAPANESE,
  RawTable,
  Warning,
  clean,
  createWarn,
  mapColumns,
  parseSchedule,
  parseSemester,
  parseTerm,
  parseTermFromMonths,
  readCode,
  runCli,
  yearFromLabel,
  termFromSemester,
} from '../common/normalizeUtils';

type PharmacyField =
  | 'subject' // 科目名 / 授業科目
  | 'semester' // セメスター(学部のテーブルにだけある)
  | 'schedule' // 曜日・講時(1つの列にまとまっている) 例 : 火曜2講時
  | 'term' // 学期(大学院のテーブルにだけある)
  | 'day' // 曜日(大学院のテーブルにだけある)
  | 'time' // 時間(大学院のテーブルにだけある) 例 : 9:00～12:00
  | 'months' // 開講期間(大学院のテーブルにだけある) 例 : 4月～5月
  | 'instructor' // 担当教員 / 代表担当教員
  | 'place'; // 講義室・実施方法

// 薬学部の講義。項目は全学部共通(BaseCourse)
export type PharmacyCourse = BaseCourse;

// 空白を除去してNFKCをかけたヘッダー名 -> フィールド
// 薬学部は講義コードの列がない
const HEADER_ALIASES: Record<string, PharmacyField> = {
  科目名: 'subject',
  授業科目: 'subject',
  セメスター: 'semester',
  '曜日・講時': 'schedule',
  学期: 'term',
  曜日: 'day',
  時間: 'time',
  開講期間: 'months',
  担当教員: 'instructor',
  代表担当教員: 'instructor',
  '講義室・実施方法': 'place',
};

// 使わない列。未知のヘッダーの警告を出さないようにする
const IGNORED_HEADERS = [
  '学科',
  '対象学科・専攻',
  '科目区分',
  '単位数',
  '科目ナンバリング',
];

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 講義コードの形式(薬学部のデータには講義コードがないので、今は全部null)

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings, 'pharmacy'); // 警告用の関数(common/normalizeUtils.ts)
  const columns = mapColumns(
    table.headers,
    HEADER_ALIASES,
    IGNORED_HEADERS,
    ['subject', 'instructor'],
    warn,
  ); // ヘッダーから「どのフィールドが何列目か」の辞書を作る。必須列がなければ警告

  // ラベルに「研究科」があれば大学院、「学部」があれば学部のテーブル
  // 例 : "薬学部・2026年度授業計画…" -> 学部, "薬学研究科・2026年度大学院授業時間割" -> 大学院
  const level: PharmacyCourse['level'] = table.label.includes('研究科')
    ? '大学院'
    : table.label.includes('学部')
      ? '学部'
      : null;
  if (level === null)
    warn(null, `ラベル「${table.label}」から学部か大学院か判断できません`);

  const courses: PharmacyCourse[] = [];
  table.rows.forEach((row, rowIndex) => {
    const get = (field: PharmacyField) =>
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

    const { code, label } = readCode('', CODE_PATTERN, get('subject'), onWarn); // 薬学部のデータには講義コードがないので、codeは必ずnull(警告も出る)

    const instructor = get('instructor'); // 担当教員を取り出す
    if (instructor !== '' && !JAPANESE.test(instructor)) {
      // 担当教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${label}: 担当教員「${instructor}」に日本語が含まれません（列ずれの可能性）`,
      );
    }

    // 曜日・講時。学部は「曜日・講時」の1列、大学院は曜日と時刻(講時ではない)
    let cellIndexes: number[] | null = null;
    if (columns.schedule !== undefined) {
      cellIndexes = parseSchedule(get('schedule')); // 例 : "火曜2講時" -> [8]
      if (cellIndexes === null) {
        // 曜日・講時の列はあるのに解釈できなかった場合は警告
        warn(
          rowIndex,
          `${label}: 曜日・講時「${get('schedule')}」を解釈できません（列ずれの可能性）`,
        );
      }
    } else if (columns.day !== undefined) {
      // 時刻が講時の時間とぴったり合わないことがあるので、時刻から講時は決めない
      warn(
        rowIndex,
        `${label}: 講時の列がないため cellIndexes: null にしました（曜日「${get('day')}」、時間「${get('time')}」）`,
      );
    }
    /*
    let cellIndexes: number[] | null = null : 先に型と初期値(null)だけ決めておいて、if文の中で値を入れる
    */

    const semester = parseSemester(get('semester'), label, onWarn); // セメスターを数字にする 例 : "5セメスター" -> 5
    // 前期・後期は、学期の列 -> 開講期間の列 -> セメスターの奇数・偶数 の順で決める
    const term =
      columns.term !== undefined
        ? parseTerm(get('term'), label, onWarn) // 例 : "第1学期" -> "前期"
        : columns.months !== undefined
          ? parseTermFromMonths(get('months'), label, onWarn) // 例 : "4月～5月" -> "前期"
          : termFromSemester(semester); // 例 : 5 -> "前期"

    // 1行分の講義情報をPharmacyCourseの形にしてcoursesに追加
    courses.push({
      code,
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      year: yearFromLabel(table.label), // 薬学部のデータには年度の列がないので、ラベルの「〇〇〇〇年度」から。なければnull
      faculty: 'pharmacy',
      systemId: table.systemId,
      level,
      term,
      semesters: level === '学部' && semester !== null ? [semester] : [], // 学部はセメスターをそのまま使う 例 : 5 -> [5]。大学院は[]
      isIntensive:
        columns.term !== undefined || columns.months !== undefined
          ? `${get('term')}${get('months')}`.includes('集中')
          : null, // 学期・開講期間の列がないテーブル(学部)はnull
      subject: get('subject'),
      subjectEnglish: null, // 薬学部のデータには英語の科目名がない
      instructor,
      classroomCode: null, // 薬学部のデータにはClassroomのクラスコードがない
      place: get('place') || null, // 空文字''ならnull
      grades: null, // 薬学部のデータには対象学年がない
      cellIndexes,
    });
  });
  return courses;
}

// 全テーブルを正規化して、講義の一覧と警告を返す(同じ講義コードでもまとめない)
export function normalizePharmacy(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses, warnings };
}

runCli(normalizePharmacy, __dirname, 'mock.json');
