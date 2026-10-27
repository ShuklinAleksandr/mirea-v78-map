import { icon } from "./icons.js";
import { $, escape } from "./dom.js";

/** Source dialogs read the application state without modifying map geometry. */
export function createSourceDialogs(state) {
  function evidenceHTML() {
    return `<div class="evidence-intro"><span>${icon("check", 24)}</span><p>Модель сохраняет происхождение геометрии. <strong>Подтверждение планом не означает точность обмерной модели.</strong></p></div><div class="evidence-grid"><article><div class="evidence-heading"><i class="evidence-dot"></i>Подтверждено материалами</div><h3>4 площадки · 23 уровня</h3><p>Контуры помещений, дворы и связи из векторных планов и каталога Ninja Mirea 5.3.0. Фотографии пожарных планов уточняют корпуса А, Б, В, Г и их нумерацию.</p><p>Вернадского, 78 и 86, Стромынка, 20: масштаб в метрах указан в метаданных. Географическая привязка приблизительна.</p></article><article><div class="evidence-heading amber"><i class="evidence-dot"></i>Приблизительно</div><h3>Высоты и фасады</h3><p>Высота уровня 3,6 м, стены 2,7 м и толщина 0,2 м приняты для визуализации. Основные контуры выведены из планов; внешняя оболочка опущена до земли без добавления неизвестных помещений. Оконные ленты, парапеты и характерные детали Вернадского, 78 воспроизведены по найденным фотографиям. Их размеры и шаг приблизительны; этот слой можно отключить.</p><p>Малая Пироговская: схематичные планы, условный масштаб. Марши и площадки лестниц А, Б, В, Г перенесены с пожарных планов; высоты, число ступеней и поручни приблизительны. Лестницы с неподтверждённой формой отмечены знаком ↕.</p></article><article><div class="evidence-heading"><i class="evidence-dot"></i>LiDAR · проверено</div><h3>Два формата, один скан</h3><p>OBJ и GLB: 140 965 вершин, 224 880 треугольников; одинаковые индексы граней и восемь одинаковых текстур. Разница координат менее 0,000001 единицы.</p><p>Область скана около 34,6 × 18,9 м по горизонтали, 8,5 м по высоте. Масштаб экспорта glTF; без контрольного обмера. Материалы сохранены для дальнейшей проверки геометрии.</p></article><article><div class="evidence-heading amber"><i class="evidence-dot"></i>Не установлено</div><h3>Привязка и актуальность</h3><p>Скан корпуса Г содержит лестницу и части двух уровней. Номер лестницы, поворот и сдвиг относительно плана не подтверждены. Поэтому скан не встроен в карту; исследование сохранено в документации проекта.</p><p>На Вернадского, 86 отдельный блок показан на месте из схемы: его расположение не подтверждено и выделено пунктиром. Не хватает обмеров высот, фасадов, кровель и подтверждения актуальности перегородок. На фото встречаются планы разных лет. Неизвестные области не дорисованы.</p></article></div><div class="numbering-note"><b>Почему «уровень» и «этаж» отличаются?</b><p>На Вернадского, 78 уровень 1 источника объединяет 1-й этаж А и 2-й этаж Б, В, Г, Д. Выбор корпуса переводит переключатель в его нумерацию. Номер исходного уровня всегда сохранён.</p></div><div class="numbering-note"><b>Фотографии внешнего вида</b><p>Фасады уточнены по <a href="https://vika-it.rtuitlab.dev/infrastructure" target="_blank">фотографиям кампуса на портале сообщества ИИТ</a> и <a href="https://ok.ru/rtumirea/topic/157218002895701" target="_blank">публикации университета</a>. Положение каждого окна не обмерено. Слой фасадной детализации можно отключить.</p></div><div class="data-links"><a href="/data/assumptions.json" target="_blank">Параметры приближённой геометрии ↗</a><a href="/data/lidar/report.json" target="_blank">Результат сравнения сканов ↗</a></div>`;
  }
  function planHTML() {
    const f =
      state.floor ||
      state.campus.floors.find((f) => f.level === 1) ||
      state.campus.floors[0];
    return `<div class="gallery-intro"><p>${escape(state.campus.title)} · уровень ${f.level}. Исходная векторная геометрия.</p><a href="${f.sourcePlanUrl}" target="_blank" rel="noopener">Открыть SVG ↗</a></div><img class="original-plan" src="${f.sourcePlanUrl}" alt="Исходный векторный план"/><p class="micro-note">${state.campus.id === "mp-1" ? "Схематичные планы University App. Масштаб не подтверждён." : "Пульс РТУ МИРЭА. Копия из предоставленного архива, состояние на сентябрь 2026."}</p>`;
  }
  function photoHTML() {
    const building = state.building;
    const available = state.photos.filter(
      (p) =>
        !building ||
        p.building === building ||
        p.building === "all" ||
        !p.building,
    );
    return `<div class="gallery-intro"><p>${state.campus.id !== "v-78" ? "Фотографии относятся к площадке Вернадского, 78" : building ? `Материалы корпуса ${escape(building)} и общие схемы` : "Все фотографии планов и сохранённые изображения"} · ${available.length} файлов</p>${building ? '<button id="all-photos">Показать все 58</button>' : ""}</div><div class="photo-grid">${available.map((p, i) => `<button class="photo-tile" data-photo="${state.photos.indexOf(p)}"><img loading="lazy" src="${escape(p.url || p.file)}" alt="${escape(p.caption || p.title || p.filename)}"/><span><b>${escape(p.caption || p.title || p.filename || "Исходный план")}</b><small>${escape(p.filename || p.source || "")}${p.floor != null ? " · " + p.floor + " этаж" : ""}</small></span></button>`).join("")}</div>`;
  }
  function openSources(tab = "evidence") {
    $("#source-dialog").showModal();
    setSourceTab(tab);
  }
  function setSourceTab(tab) {
    for (const b of document.querySelectorAll("[data-tab]"))
      b.classList.toggle("active", b.dataset.tab === tab);
    $("#dialog-content").innerHTML =
      tab === "photos"
        ? photoHTML()
        : tab === "plan"
          ? planHTML()
          : evidenceHTML();
    for (const b of document.querySelectorAll("[data-photo]"))
      b.onclick = () => {
        const p = state.photos[+b.dataset.photo];
        $("#photo-full").src = p.url || p.file;
        $("#photo-full").alt = p.caption || p.title || "План";
        $("#photo-caption").textContent = [
          p.caption || p.title,
          p.filename,
          p.notes,
        ]
          .filter(Boolean)
          .join(" · ");
        $("#photo-dialog").showModal();
      };
    if ($("#all-photos"))
      $("#all-photos").onclick = () => {
        const old = state.building;
        state.building = null;
        setSourceTab("photos");
        state.building = old;
      };
  }

  function openPhoto(url, caption) {
    $("#photo-full").src = url;
    $("#photo-full").alt = caption;
    $("#photo-caption").textContent = caption;
    $("#photo-dialog").showModal();
  }
  return { openSources, setSourceTab, openPhoto };
}
