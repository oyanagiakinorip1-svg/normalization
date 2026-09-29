import {
  BaseCourse,
  CourseStatus,
  Warning,
  clean,
  mergeByCode,
  readCode,
  runCli,
} from '../common/normalizeUtils';

// 農学部のスクレイパーの出力。ほかの学部と違ってRawTable(headersとrows)ではなく、1講義が1つのオブジェクトになっている
type RawAgricultureCourse = {
  school: string; // 'undergraduate'(学部) / 'graduate'(大学院)
  subject: string; // 科目名
  classroomCode: string; // Classroomのクラスコード。不開講ならクラスコードではなく「不開講」と書かれている(出力ではnullにする)
  page: number; // 元のPDFのページ
  degree?: string; // 'master' / 'doctoral'(大学院のみ)
  lectureCode: string | null; // 照合できた講義コード
  status: string; // 'matched' / 'unmatched' / 'ambiguous' / 'not-offered'
  candidateCodes: string[]; // 講義コードの候補
};
/*
degree?: string : ?をつけると「この項目はなくてもいい」という意味になる
学部の講義にはdegreeがないので?をつけている
*/

// BaseCourseに農学部だけの項目を足した型
export type AgricultureCourse = BaseCourse & {
  page: number; // 元のPDFのページ
  candidateCodes: string[]; // 講義コードの候補(ambiguousのときに複数入る)
};

const SYSTEM_ID = 'agriculture';

const CODE_PATTERN = /^[A-Z]{2}\d+$/; // 頭がアルファベット２文字で1つ以上の数字が続く 例 : AB9991

// school -> level
const LEVEL_ALIASES: Record<string, AgricultureCourse['level']> = {
  undergraduate: '学部',
  graduate: '大学院',
};

// 全講義を正規化して、講義コードでまとめたものと警告を返す
export function normalizeAgriculture(raws: RawAgricultureCourse[]) {
  const warnings: Warning[] = []; // 警告リスト
  const courses: AgricultureCourse[] = [];

  raws.forEach((raw, index) => {
    // 警告用の関数。農学部はテーブルがないので、tableIndexは-1にして、何番目の講義かをrowに入れる
    const warn = (message: string) =>
      warnings.push({
        systemId: SYSTEM_ID,
        tableIndex: -1,
        row: index,
        message: `p.${raw.page} ${message}`, // 元のPDFのページも表示
      });

    const subject = clean(raw.subject);

    // statusごとに講義コードを決める
    let code: string | null = null;
    let status: CourseStatus;
    if (raw.status === 'matched') {
      // 照合できた講義コードの形式もチェック。形式が想定外ならunmatched
      code = readCode(raw.lectureCode ?? '', CODE_PATTERN, subject, warn).code;
      status = code === null ? 'unmatched' : 'matched';
    } else if (raw.status === 'ambiguous') {
      status = 'ambiguous';
      warn(
        `${subject}: 講義コードの候補が複数あるため code: null にしました（${raw.candidateCodes.join(', ')}）`,
      );
    } else if (raw.status === 'unmatched') {
      status = 'unmatched';
      warn(`${subject}: 講義コードが見つからないため code: null にしました`);
    } else if (raw.status === 'not-offered') {
      status = 'not-offered'; // 不開講はそういうものなので警告は出さない
    } else {
      status = 'unmatched';
      warn(
        `${subject}: status「${raw.status}」が想定外のため unmatched にしました`,
      );
    }

    const level = LEVEL_ALIASES[raw.school] ?? null; // 'undergraduate'なら'学部'、'graduate'なら'大学院'、それ以外はnull
    if (level === null) {
      warn(`${subject}: school「${raw.school}」が想定外です`);
    }

    const classroomCode = clean(raw.classroomCode);

    // 1件分の講義情報をAgricultureCourseの形にしてcoursesに追加
    courses.push({
      code,
      status,
      systemIds: [SYSTEM_ID],
      level,
      term: null, // 農学部のデータには開講時期がない
      semester: null,
      subject,
      instructor: '', // 農学部のデータには教員がない
      classroomCode:
        classroomCode === '' || classroomCode === '不開講'
          ? null
          : classroomCode, // 空文字''や「不開講」ならnull
      page: raw.page,
      candidateCodes: raw.candidateCodes,
    });
  });
  return { courses: mergeByCode(courses, warnings), warnings };
  /*
  let status: CourseStatus : 型だけ先に決めておいて、値はif文の中で入れる
  どのif文を通っても必ず値が入るので、TypeScriptはエラーにしない

  readCode(...).code : readCodeの返り値 { code, label } から、codeだけを取り出している
  */
}

runCli(normalizeAgriculture, __dirname, 'mock.json');
