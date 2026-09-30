import {
  BaseCourse,
  JAPANESE,
  RawTable,
  Warning,
  clean,
  createWarn,
  mapColumns,
  parseGrades,
  parseSchedule,
  parseSemester,
  parseTerm,
  parseTermFromMonths,
  readCode,
  runCli,
  yearFromLabel,
  semestersFromGrades,
  termFromSemester,
} from '../common/normalizeUtils';

type MedicineField =
  | 'subject' // 授業科目
  | 'grades' // 対象学年(医学科のテーブルにだけある)
  | 'months' // 授業期間(医学科のテーブルにだけある) 例 : 2026年4月～7月
  | 'term' // 学期
  | 'semester' // セメスター
  | 'schedule' // 曜日・時限(1つの列にまとまっている) 例 : 月曜4～5時限
  | 'day' // 曜日
  | 'period' // 講時
  | 'instructor' // 担当教員 / 代表教員
  | 'place'; // 場所 / 教室 / 場所・実施方法

// 医学部の講義。項目は全学部共通(BaseCourse)
export type MedicineCourse = BaseCourse;

// 空白を除去してNFKCをかけたヘッダー名 -> フィールド
// 医学部は講義コードの列がない
const HEADER_ALIASES: Record<string, MedicineField> = {
  授業科目: 'subject',
  対象学年: 'grades',
  授業期間: 'months',
  学期: 'term',
  セメスター: 'semester',
  '曜日・時限': 'schedule',
  曜日: 'day',
  講時: 'period',
  担当教員: 'instructor',
  代表教員: 'instructor',
  場所: 'place',
  教室: 'place',
  '場所・実施方法': 'place',
};

// 使わない列。未知のヘッダーの警告を出さないようにする
const IGNORED_HEADERS = [
  '責任担当分野', // 人の名前ではなく分野の名前なので担当教員には入れない
  '単位数',
  '科目区分',
  '時間', // 講時の列もあるテーブルにしか出てこない
  '選択',
  'CanvasLMSにて開講',
  '座学',
  '備考',
  '専攻',
  '課程',
  'コース',
];

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 講義コードの形式(医学部のデータには講義コードがないので、今は全部null)

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings, 'medicine'); // 警告用の関数(common/normalizeUtils.ts)
  const columns = mapColumns(
    table.headers,
    HEADER_ALIASES,
    IGNORED_HEADERS,
    ['subject'], // 講義コードや担当教員の列がないテーブルもあるので、必須は授業科目だけ
    warn,
  ); // ヘッダーから「どのフィールドが何列目か」の辞書を作る。必須列がなければ警告

  // ラベルに「研究科」があれば大学院、「学部」があれば学部のテーブル
  // 例 : "医学部医学科・医学専門教育シラバス" -> 学部, "医学系研究科・医科学専攻修士課程・…" -> 大学院
  const level: MedicineCourse['level'] = table.label.includes('研究科')
    ? '大学院'
    : table.label.includes('学部')
      ? '学部'
      : null;
  if (level === null)
    warn(null, `ラベル「${table.label}」から学部か大学院か判断できません`);

  const courses: MedicineCourse[] = [];
  table.rows.forEach((row, rowIndex) => {
    const get = (field: MedicineField) =>
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

    const { code, label } = readCode('', CODE_PATTERN, get('subject'), onWarn); // 医学部のデータには講義コードがないので、codeは必ずnull(警告も出る)

    const instructor = get('instructor'); // 担当教員を取り出す。列がないテーブルは''
    if (instructor !== '' && !JAPANESE.test(instructor)) {
      // 担当教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${label}: 担当教員「${instructor}」に日本語が含まれません（列ずれの可能性）`,
      );
    }

    // 曜日・講時。1つの列にまとまっているテーブルと、曜日と講時が別々のテーブルがある
    const scheduleText =
      columns.schedule !== undefined
        ? get('schedule') // 例 : "月曜4～5時限"
        : `${get('day')}${get('period')}`; // 例 : "月" + "1" -> "月1"
    const hasSchedule =
      columns.schedule !== undefined ||
      (columns.day !== undefined && columns.period !== undefined);
    const cellIndexes = hasSchedule ? parseSchedule(scheduleText) : null; // 曜日・講時の列がないテーブルはnull
    if (hasSchedule && cellIndexes === null) {
      // 曜日・講時の列はあるのに解釈できなかった場合は警告
      warn(
        rowIndex,
        `${label}: 曜日・講時「${scheduleText}」を解釈できません（列ずれの可能性）`,
      );
    }

    const semester = parseSemester(get('semester'), label, onWarn); // セメスターを数字にする 例 : "1セメスター" -> 1
    // 前期・後期は、学期の列 -> 授業期間の列 -> セメスターの奇数・偶数 の順で決める
    const term =
      columns.term !== undefined
        ? parseTerm(get('term'), label, onWarn) // 例 : "前期" -> "前期"
        : columns.months !== undefined
          ? parseTermFromMonths(get('months'), label, onWarn) // 例 : "2026年4月～7月" -> "前期"
          : termFromSemester(semester); // 例 : 3 -> "前期"
    const grades = parseGrades(get('grades'), label, onWarn); // 対象学年を数字の配列にする 例 : "2年生" -> [2]

    // 1行分の講義情報をMedicineCourseの形にしてcoursesに追加
    courses.push({
      code,
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      year: yearFromLabel(table.label), // 医学部のデータには年度の列がないので、ラベルの「〇〇〇〇年度」から。なければnull
      faculty: 'medicine',
      systemId: table.systemId,
      level,
      term,
      // 大学院は学部と数え方が違うので[](セメスターが書いてあっても入れない)
      // 学部はセメスターがあればそれを使い、なければ対象学年と前期・後期から計算する
      semesters:
        level !== '学部'
          ? []
          : semester !== null
            ? [semester]
            : semestersFromGrades(grades, term),
      isIntensive:
        columns.term !== undefined || columns.months !== undefined
          ? `${get('term')}${get('months')}`.includes('集中')
          : null, // 学期・授業期間の列がないテーブルはnull
      subject: get('subject'),
      subjectEnglish: null, // 医学部のデータには英語の科目名がない
      instructor,
      classroomCode: null, // 医学部のデータにはClassroomのクラスコードがない
      place: get('place') || null, // 空文字''ならnull
      grades,
      cellIndexes,
    });
  });
  return courses;
}

// 全テーブルを正規化して、講義の一覧と警告を返す(同じ講義コードでもまとめない)
export function normalizeMedicine(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses, warnings };
}

runCli(normalizeMedicine, __dirname, 'mock.json');
