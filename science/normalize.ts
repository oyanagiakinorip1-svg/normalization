import {
  BaseCourse,
  JAPANESE,
  RawTable,
  Warning,
  clean,
  createWarn,
  mapColumns,
  mergeByCode,
  parseSemester,
  parseTerm,
  parseSchedule,
  readCode,
  runCli,
  termFromSemester,
} from '../common/normalizeUtils';

type ScienceField =
  | 'department' // 学科(学部のテーブルにだけある)
  | 'program' // 課程(大学院のテーブルにだけある)
  | 'term' // 学期(大学院のテーブルにだけある)
  | 'semester' // セメスター(学部のテーブルにだけある)
  | 'day' // 曜日
  | 'period' // 講時
  | 'code' // 履修用コード(大学院のテーブルにはない)
  | 'subject' // 授業科目名
  | 'instructor' // 教員
  | 'room'; // 教室

// BaseCourseに理学部だけの項目を足した型
export type ScienceCourse = BaseCourse & {
  room: string | null; // 教室
  // Syllabus.cellIndexes と同じ採番: (講時 - 1) * 7 + 曜日(月=0)
  cellIndexes: number[] | null;
};

// 空白を除去してNFKCをかけたヘッダー名 -> フィールド
const HEADER_ALIASES: Record<string, ScienceField> = {
  学科: 'department',
  課程: 'program',
  セメスター: 'semester',
  学期: 'term',
  曜日: 'day',
  講時: 'period',
  履修用コード: 'code',
  授業科目名: 'subject',
  教員: 'instructor',
  教室: 'room',
};

// 使わない列。未知のヘッダーの警告を出さないようにする
const IGNORED_HEADERS = [
  '区分', // 必修・選択
  '専攻',
  '対象学年',
];

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 頭がアルファベット２文字で1つ以上の数字が続く 例 : SB2121

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings); // 警告用の関数(common/normalizeUtils.ts)
  const columns = mapColumns(
    table.headers,
    HEADER_ALIASES,
    IGNORED_HEADERS,
    ['subject', 'instructor'], // 大学院のテーブルには講義コードの列がないので必須にしない
    warn,
  ); // ヘッダーから「どのフィールドが何列目か」の辞書を作る。必須列がなければ警告

  // 学科の列があれば学部、課程の列があれば大学院のテーブル
  const level: ScienceCourse['level'] =
    columns.program !== undefined
      ? '大学院'
      : columns.department !== undefined
        ? '学部'
        : null;
  if (level === null) warn(null, '学部か大学院か判断できません');

  const courses: ScienceCourse[] = [];
  table.rows.forEach((row, rowIndex) => {
    const get = (field: ScienceField) =>
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

    const instructor = get('instructor'); // 教員を取り出す 例 : "山田太郎 教授"
    if (instructor !== '' && !JAPANESE.test(instructor)) {
      // 教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${label}: 教員「${instructor}」に日本語が含まれません（列ずれの可能性）`,
      );
    }

    // 曜日と講時が別々の列なので、つなげてからparseScheduleにかける
    const schedule = `${get('day').replace(/曜日?$/, '')}${get('period')}`; // 例 : "月" + "1" -> "月1"
    const cellIndexes =
      columns.day === undefined || columns.period === undefined
        ? null
        : parseSchedule(schedule); // 曜日・講時の列がないテーブルはnull。どちらも空欄なら[](決まった曜日・講時がない)
    if (cellIndexes === null && columns.day !== undefined) {
      // 曜日・講時の列はあるのに解釈できなかった場合は警告
      warn(
        rowIndex,
        `${label}: 曜日・講時「${get('day')} ${get('period')}」を解釈できません（列ずれの可能性）`,
      );
    }

    const onWarn = (message: string) => warn(rowIndex, message); // parseTermとparseSemester用の警告関数
    const semester = parseSemester(get('semester'), label, onWarn); // セメスターを数字にする 例 : "5セメ" -> 5

    // 1行分の講義情報をScienceCourseの形にしてcoursesに追加
    courses.push({
      code,
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      systemIds: [table.systemId],
      level,
      term: parseTerm(get('term'), label, onWarn) ?? termFromSemester(semester), // 大学院は学期から(例 : "第1学期" -> "前期")、学部はセメスターの奇数・偶数から(例 : 5 -> "前期")
      semester,
      subject: get('subject'),
      instructor,
      room: get('room') || null, // 空文字''ならnull
      classroomCode: null, // 理学部のデータにはClassroomのクラスコードがない
      cellIndexes,
    });
  });
  return courses;
}

// 全テーブルを正規化して、講義コードでまとめたものと警告を返す
export function normalizeScience(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses: mergeByCode(courses, warnings), warnings };
}

runCli(normalizeScience, __dirname, 'mock.json');
