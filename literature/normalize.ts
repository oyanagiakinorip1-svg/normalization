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
  parseSchedule,
  readCode,
  runCli,
  termFromSemester,
} from '../common/normalizeUtils';

type LiteratureField =
  | 'target' // 対象(文学部・2～4年次 / 文学研究科)
  | 'day' // 曜日
  | 'period' // 講時
  | 'code' // 講義CD / 講義コード
  | 'semester' // セメスター
  | 'subject' // 授業科目名 / 科目
  | 'instructor' // 教員
  | 'room' // 教室
  | 'classroomCode' // クラスコード
  | 'roomAndClassroomCode'; // 教室／クラスコード(1年次のテーブルは1つの列にまとまっている)

// BaseCourseに文学部だけの項目を足した型
export type LiteratureCourse = BaseCourse & {
  room: string | null; // 教室
  // Syllabus.cellIndexes と同じ採番: (講時 - 1) * 7 + 曜日(月=0)
  cellIndexes: number[] | null;
};

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
  教室: 'room',
  クラスコード: 'classroomCode',
  '教室/クラスコード': 'roomAndClassroomCode', // 「／」(全角)はNFKCで「/」(半角)になる
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
  const warn = createWarn(table, warnings); // 警告用の関数(common/normalizeUtils.ts)
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
    let room = get('room');
    let classroomCode = get('classroomCode');
    if (columns.roomAndClassroomCode !== undefined) {
      const [first, second] = get('roomAndClassroomCode').split(/[/／]/); // 半角「/」と全角「／」のどちらでも分ける
      room = first?.trim() ?? '';
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

    const level = parseLevel(get('target')); // 対象から学部・大学院を決める
    if (columns.target !== undefined && level === null) {
      // 対象の列はあるのに想定外の値だった場合は警告
      warn(rowIndex, `${label}: 対象「${get('target')}」が想定外です`);
    }

    const semester = parseSemester(get('semester'), label, (message) =>
      warn(rowIndex, message),
    ); // セメスターを数字にする 例 : "02" -> 2

    // 1行分の講義情報をLiteratureCourseの形にしてcoursesに追加
    courses.push({
      code,
      status: code === null ? 'unmatched' : 'matched', // 講義コードが取れたかどうか
      systemIds: [table.systemId],
      level,
      term: termFromSemester(semester), // 文学部のデータには前期・後期の列がないので、セメスターの奇数・偶数から決める 例 : 2 -> "後期"
      semester,
      subject: get('subject'),
      instructor,
      room: room || null, // 空文字''ならnull
      classroomCode: classroomCode || null, // 空文字''ならnull
      cellIndexes,
    });
  });
  return courses;
}

// 全テーブルを正規化して、講義コードでまとめたものと警告を返す
export function normalizeLiterature(tables: RawTable[]) {
  const warnings: Warning[] = []; // 全テーブル共通の警告リスト
  const courses = tables.flatMap((table) => normalizeTable(table, warnings)); // 各テーブルを正規化して1つの配列につなげる
  return { courses: mergeByCode(courses, warnings), warnings };
}

runCli(normalizeLiterature, __dirname, 'mock.json');
