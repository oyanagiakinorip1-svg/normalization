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
  readCode,
  runCli,
  yearFromLabel,
  semestersFromGrades,
  termFromSemester,
} from '../common/normalizeUtils';

type DentistryField =
  | 'term' // 学期
  | 'day' // 曜日
  | 'grades' // 学年
  | 'semester' // セメスター
  | 'period' // 講時
  | 'subject' // 授業科目
  | 'place' // 講義室
  | 'instructor'; // 担当教員

// 歯学部の講義。項目は全学部共通(BaseCourse)
export type DentistryCourse = BaseCourse;

// 空白を除去してNFKCをかけたヘッダー名 -> フィールド
// 歯学部は講義コードの列がない
const HEADER_ALIASES: Record<string, DentistryField> = {
  学期: 'term',
  曜日: 'day',
  学年: 'grades',
  セメスター: 'semester',
  講時: 'period',
  授業科目: 'subject',
  講義室: 'place',
  担当教員: 'instructor',
};

// 使わない列。未知のヘッダーの警告を出さないようにする
const IGNORED_HEADERS = ['区分', '単位数', '備考'];

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 講義コードの形式(歯学部のデータには講義コードがないので、今は全部null)

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings, 'dentistry'); // 警告用の関数(common/normalizeUtils.ts)
  const columns = mapColumns(
    table.headers,
    HEADER_ALIASES,
    IGNORED_HEADERS,
    ['subject'], // 大学院のテーブルは授業科目と単位数くらいしかないので、必須は授業科目だけ
    warn,
  ); // ヘッダーから「どのフィールドが何列目か」の辞書を作る。必須列がなければ警告

  // ラベルに「研究科」があれば大学院、「学部」があれば学部のテーブル
  // 例 : "歯学部歯学科・…" -> 学部, "歯学研究科修士課程・…" -> 大学院
  const level: DentistryCourse['level'] = table.label.includes('研究科')
    ? '大学院'
    : table.label.includes('学部')
      ? '学部'
      : null;
  if (level === null)
    warn(null, `ラベル「${table.label}」から学部か大学院か判断できません`);

  const courses: DentistryCourse[] = [];
  table.rows.forEach((row, rowIndex) => {
    const get = (field: DentistryField) =>
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

    const { code, label } = readCode('', CODE_PATTERN, get('subject'), onWarn); // 歯学部のデータには講義コードがないので、codeは必ずnull(警告も出る)

    const instructor = get('instructor'); // 担当教員を取り出す。列がないテーブルは''
    if (instructor !== '' && !JAPANESE.test(instructor)) {
      // 担当教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${label}: 担当教員「${instructor}」に日本語が含まれません（列ずれの可能性）`,
      );
    }

    // 曜日と講時が別々の列なので、つなげてからparseScheduleにかける
    const cellIndexes =
      columns.day === undefined || columns.period === undefined
        ? null
        : parseSchedule(`${get('day')}${get('period')}`); // 曜日・講時の列がないテーブル(大学院)はnull
    if (cellIndexes === null && columns.day !== undefined) {
      // 曜日・講時の列はあるのに解釈できなかった場合は警告
      warn(
        rowIndex,
        `${label}: 曜日・講時「${get('day')} ${get('period')}」を解釈できません（列ずれの可能性）`,
      );
    }

    const semester = parseSemester(get('semester'), label, onWarn); // セメスターを数字にする 例 : "5" -> 5
    const term =
      parseTerm(get('term'), label, onWarn) ?? termFromSemester(semester); // 学期から、なければセメスターの奇数・偶数から 例 : "前期" -> "前期"
    const grades = parseGrades(get('grades'), label, onWarn); // 学年を数字の配列にする 例 : "3" -> [3]

    // 1行分の講義情報をDentistryCourseの形にしてcoursesに追加
    courses.push({
      code,
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      year: yearFromLabel(table.label), // 歯学部のデータには年度の列がないので、ラベルの「〇〇〇〇年度」から。なければnull
      faculty: 'dentistry',
      systemId: table.systemId,
      level,
      term,
      // 学部はセメスターがあればそれを使い、なければ対象学年と前期・後期から計算する。大学院は[]
      semesters:
        level !== '学部'
          ? []
          : semester !== null
            ? [semester]
            : semestersFromGrades(grades, term),
      isIntensive:
        columns.term === undefined ? null : get('term').includes('集中'), // 学期の列がないテーブル(大学院)はnull
      subject: get('subject'),
      subjectEnglish: null, // 歯学部のデータには英語の科目名がない
      instructor,
      classroomCode: null, // 歯学部のデータにはClassroomのクラスコードがない
      place: get('place') || null, // 空文字''ならnull
      grades,
      cellIndexes,
    });
  });
  return courses;
}

// 全テーブルを正規化して、講義の一覧と警告を返す(同じ講義コードでもまとめない)
export function normalizeDentistry(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses, warnings };
}

runCli(normalizeDentistry, __dirname, 'mock.json');
