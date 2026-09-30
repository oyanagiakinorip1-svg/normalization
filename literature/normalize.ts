import {
  BaseCourse,
  JAPANESE,
  RawTable,
  Warning,
  clean,
  createWarn,
  mapColumns,
  parseSemester,
  parseSchedule,
  readCode,
  runCli,
  yearFromLabel,
  termFromSemester,
  parseGrades,
  semestersFromGrades,
} from '../common/normalizeUtils';

type LiteratureField =
  | 'target' // 対象(文学部・2～4年次 / 文学研究科)
  | 'day' // 曜日
  | 'period' // 講時
  | 'code' // 講義CD / 講義コード
  | 'semester' // セメスター
  | 'subject' // 授業科目名 / 科目
  | 'instructor' // 教員
  | 'place' // 教室
  | 'classroomCode' // クラスコード
  | 'placeAndClassroomCode'; // 教室／クラスコード(1年次のテーブルは1つの列にまとまっている)

// 文学部の講義。項目は全学部共通(BaseCourse)
export type LiteratureCourse = BaseCourse;

// 空白を除去してNFKCをかけたヘッダー名 -> フィールド
const HEADER_ALIASES: Record<string, LiteratureField> = {
  対象: 'target',
  曜日: 'day',
  講時: 'period',
  講義CD: 'code',
  講義コード: 'code',
  セメスター: 'semester',
  授業科目名: 'subject',
  科目: 'subject',
  教員: 'instructor',
  教室: 'place',
  クラスコード: 'classroomCode',
  '教室/クラスコード': 'placeAndClassroomCode', // 「／」(全角)はNFKCで「/」(半角)になる
};

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 頭がアルファベット２文字で1つ以上の数字が続く 例 : LB99991

// 「対象」の値からlevelを決める
function parseLevel(value: string): LiteratureCourse['level'] {
  if (value.includes('研究科')) return '大学院'; // 例 : 文学研究科
  if (value.includes('学部')) return '学部'; // 例 : 文学部・2～4年次
  return null;
}

// 講義情報を正規化
function normalizeTable(table: RawTable, warnings: Warning[]) {
  const warn = createWarn(table, warnings, 'literature'); // 警告用の関数(common/normalizeUtils.ts)
  const columns = mapColumns(
    table.headers,
    HEADER_ALIASES,
    [],
    ['code', 'subject', 'instructor'],
    warn,
  ); // ヘッダーから「どのフィールドが何列目か」の辞書を作る。必須列がなければ警告

  const courses: LiteratureCourse[] = [];
  table.rows.forEach((row, rowIndex) => {
    const get = (field: LiteratureField) =>
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

    const instructor = get('instructor'); // 教員を取り出す
    if (instructor !== '' && !JAPANESE.test(instructor)) {
      // 教員名に日本語が1文字も含まれない場合は別の列の値が入っている可能性があるので警告
      warn(
        rowIndex,
        `${label}: 教員「${instructor}」に日本語が含まれません（列ずれの可能性）`,
      );
    }

    // 曜日と講時が別々の列なので、つなげてからparseScheduleにかける
    const schedule = `${get('day').replace(/曜日?$/, '')}${get('period')}`; // 例 : "月曜日" + "3" -> "月3"
    const cellIndexes =
      columns.day === undefined || columns.period === undefined
        ? null
        : parseSchedule(schedule); // 曜日・講時の列がないテーブルはnull
    if (cellIndexes === null && columns.day !== undefined) {
      // 曜日・講時の列はあるのに解釈できなかった場合は警告
      warn(
        rowIndex,
        `${label}: 曜日・講時「${get('day')} ${get('period')}」を解釈できません（列ずれの可能性）`,
      );
    }
    /*
    .replace(/曜日?$/, '') : 末尾の「曜日」または「曜」を消す
    ? : 直前の文字が「あってもなくてもいい」こと
    $ : 文字列の末尾
    例 : "月曜日" -> "月", "月曜" -> "月", "月" -> "月"
    */

    // 教室とクラスコードを取り出す。1年次のテーブルは「701／sample01」のように1つの列にまとまっている
    let place = get('place');
    let classroomCode = get('classroomCode');
    if (columns.placeAndClassroomCode !== undefined) {
      const [first, second] = get('placeAndClassroomCode').split(/[/／]/); // 半角「/」と全角「／」のどちらでも分ける
      place = first?.trim() ?? '';
      classroomCode = second?.trim() ?? '';
    }
    /*
    let : あとで値を変えられる変数(constは変えられない)

    const [first, second] = ... : 分割代入(配列版)
    配列の1番目をfirst、2番目をsecondに入れる
    例 : "701／sample01".split(/[/／]/) -> ['701', 'sample01'] -> first = '701', second = 'sample01'
    "/"がなければ second は undefined になる

    first?.trim() : オプショナルチェーン
    firstがundefinedならエラーにならずにundefinedを返す。そのあとの ?? '' で空文字にしている
    */

    // 対象から学部・大学院を決める。対象の列がないテーブルは、ラベルから決める 例 : "文学部・1年次" -> "学部"
    const level =
      columns.target !== undefined
        ? parseLevel(get('target'))
        : parseLevel(table.label);
    if (level === null) {
      // 想定外の値だった場合は警告
      warn(
        rowIndex,
        columns.target !== undefined
          ? `${label}: 対象「${get('target')}」が想定外です`
          : `${label}: ラベル「${table.label}」から学部か大学院か判断できません`,
      );
    }

    const semester = parseSemester(get('semester'), label, (message) =>
      warn(rowIndex, message),
    ); // セメスターを数字にする 例 : "02" -> 2

    const term = termFromSemester(semester); // 文学部のデータには前期・後期の列がないので、セメスターの奇数・偶数から決める 例 : 2 -> "後期"
    // 「対象」に学年が書いてあれば取り出す 例 : "文学部・2～4年次" -> [2, 3, 4]。「文学研究科」のように数字がなければnull
    const grades = /\d/.test(get('target'))
      ? parseGrades(get('target'), label, (message) => warn(rowIndex, message))
      : null;

    // 1行分の講義情報をLiteratureCourseの形にしてcoursesに追加
    courses.push({
      code,
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      year: yearFromLabel(table.label), // 文学部のデータには年度の列がないので、ラベルの「〇〇〇〇年度」から。なければnull
      faculty: 'literature',
      systemId: table.systemId,
      level,
      term,
      // セメスターがあればそれを使う 例 : 2 -> [2]。なければ学部の講義だけ対象学年と前期・後期から計算する(大学院は学部と数え方が違うので計算しない)
      semesters:
        semester !== null
          ? [semester]
          : level === '学部'
            ? semestersFromGrades(grades, term)
            : [],
      isIntensive: null, // 文学部のデータには前期・後期や集中の列がない
      subject: get('subject'),
      subjectEnglish: null, // 文学部のデータには英語の科目名がない
      instructor,
      place: place || null, // 空文字''ならnull
      classroomCode: classroomCode || null, // 空文字''ならnull
      grades,
      cellIndexes,
    });
  });
  return courses;
}

// 全テーブルを正規化して、講義の一覧と警告を返す(同じ講義コードでもまとめない)
export function normalizeLiterature(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses, warnings };
}

runCli(normalizeLiterature, __dirname, 'mock.json');
