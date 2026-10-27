# Первое размещение на GitHub

Это инструкция владельцу для первоначальной загрузки. Участники команды затем клонируют репозиторий и следуют [CONTRIBUTING.md](../CONTRIBUTING.md).

## Создание репозитория

На [github.com/new](https://github.com/new) создайте пустой репозиторий, например `mirea-v78-map`. Не включайте автоматическое создание README, .gitignore и лицензии: первые два уже подготовлены, условия лицензирования описаны в [DATA_SOURCES.md](DATA_SOURCES.md).

Описание для поля Description:

> Интерактивная 2D/3D-карта РТУ МИРЭА (Вернадского, 78): поиск аудиторий и сервисов, маршруты, геопозиция и мобильные проекты Android/iOS на Capacitor.

Видимость выбирает владелец с учётом прав на исходные материалы. Для первоначальной работы команды можно выбрать Private и добавить участников в Settings → Collaborators.

## Загрузка

Распакуйте архив. В Terminal перейдите в папку `mirea-v78-map`, где находятся `package.json`, `README.md` и `src/`. Выполняйте команды по одной:

```sh
git init -b main
git add .
git status --short
git diff --cached --stat
git commit -m "Initial import: MIREA V78 map"
```

Если Git запросит имя и email автора, задайте свои данные через `git config user.name` и `git config user.email` для этого репозитория и повторите commit.

Подставьте URL собственного пустого репозитория:

```sh
git remote add origin https://github.com/YOUR_LOGIN/mirea-v78-map.git
git push -u origin main
```

Авторизуйтесь обычным credential manager или SSH. Вариант без Terminal: GitHub Desktop → Add Local Repository → выбрать подготовленную папку → Publish repository. Если репозиторий уже содержит коммиты, клонируйте его и перенесите проект в существующую историю без force push.

Загружаются файлы проекта, включая скрытую папку `.github` и `.gitignore`. ZIP служит для передачи исходного снимка; его не нужно коммитить одним файлом. В текущих исходниках крупнейший файл около 11 МиБ, Git LFS для этого набора не требуется.

## После загрузки

1. Откройте Actions и проверьте результат workflow `Web checks`: `npm ci` → `npm run check` на Node 24 с Python 3. Пока workflow на GitHub не выполнялся.
2. Добавьте участников и отправьте им ссылку на репозиторий. Они выбирают Code → Clone или Download ZIP, затем выполняют `npm ci` и `npm run dev`.
3. Для работы с проверкой изменений используйте ветки, Issues и Pull Request. При необходимости настройте защиту `main` и обязательную проверку `check`.
4. В полном архиве готовые APK и ZIP для iOS Simulator лежат в `release-assets/` (папка исключена из Git). Создайте Release через вкладку Releases → Draft a new release и прикрепите эти файлы и `SHA256SUMS.txt`, вместе с описанием проверок. Исходный проект для iPhone уже находится в репозитории; Simulator ZIP не устанавливается на iPhone.

## Официальные инструкции

- [Добавление существующего кода](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)
- [Совместная работа через Pull Request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests)
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Проверка Node.js в GitHub Actions](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)
