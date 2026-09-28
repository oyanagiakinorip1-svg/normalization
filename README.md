# normalization

シラバスのスクレイピング結果（学部・系ごとの講義一覧テーブル）を、学部ごとのルールで正規化するスクリプトです。

## フォルダ構成

| フォルダ | 内容 |
|---|---|
| `common/` | 全学部で共通の処理（空白の整形、ヘッダーと列の対応付け、講義コードでのまとめ、警告） |
| `engineering/` | 工学部用 |
| `law/` | 法学部用 |

## 使い方

```
npm install
npx tsx engineering/normalize.ts [入力JSON] [出力JSON]
npx tsx law/normalize.ts [入力JSON] [出力JSON]
```

入力と出力を省略した場合は、同じフォルダの `engineering.json`（または `law.json`）を読み込み、`out.json` に書き出します。

## 出力

- `courses`: 正規化した講義の一覧。同じ講義コードは1件にまとめ、`systemIds` に掲載元の系を並べる
- `warnings`: 列ずれの疑いなど、確認が必要なデータ。データそのものは自動で直さない
