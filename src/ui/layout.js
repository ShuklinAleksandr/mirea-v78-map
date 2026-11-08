import { icon } from "./icons.js";
export const layout = `
<header class="topbar">
  <a href="#" class="brand" style="display: none;" aria-label="..."></a>

<button class="icon-button" id="settings-open" aria-label="Настройки">${icon("settings")}</button></header>
<aside class="sidebar" aria-label="Поиск и навигация"><button class="sheet-handle" id="sheet-toggle" aria-controls="sheet-content" aria-label="Развернуть панель" aria-expanded="false"><span class="sheet-grip"></span><span class="sheet-collapsed-title">Поиск и маршрут</span></button>
  <div class="sidebar-scroll" id="sheet-content">
    <div class="campus-heading">${icon("pin", 20)}<b>Вернадского, 78</b><span>РТУ МИРЭА</span></div>
    <div class="address" id="address">Загрузка данных…</div>
    <nav class="panel-tabs" aria-label="Раздел карты"><button id="explore-tab" class="active" aria-pressed="true">${icon("search", 17)}Поиск</button><button id="route-tab" aria-pressed="false">${icon("route", 18)}Маршрут</button></nav><div id="explore-panel"><div class="search-wrap"><label class="search-box">${icon("search", 19)}<input id="search" type="search" autocomplete="off" placeholder="Аудитория или нужное место" aria-label="Поиск помещения" role="combobox" aria-autocomplete="list" aria-controls="results" aria-expanded="false"/><button type="button" id="search-clear" aria-label="Очистить поиск и категорию" hidden>${icon("close", 17)}</button></label><div id="results" class="search-results" role="listbox" aria-label="Найденные места" hidden></div><p id="search-status" class="search-status" role="status"></p></div>
    <div id="place-categories" class="place-categories" role="group" aria-label="Полезные места"></div>
    <div id="saved-places"></div><div class="explore-details"><div class="section-heading"><h2>Корпуса</h2><span id="building-count"></span></div>
    <button class="overview-button active" id="overview">${icon("cube", 22)}<span><b>Общий вид</b><small>Корпуса и внутренние дворы</small></span>${icon("arrow", 17)}</button>
    <div class="subheading">КОРПУС</div>
    <div class="building-grid" id="buildings"></div>
  </div></div>
<section class="room-card" id="room-card" hidden aria-live="polite"></section>
<section id="route-panel" hidden aria-label="Построить маршрут">
<div class="route-inputs"><label><span class="endpoint-dot start"></span><span class="sr-only">Откуда</span><input id="route-from" placeholder="Откуда · аудитория или вход" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="route-results" aria-expanded="false"/></label><label><span class="endpoint-dot end"></span><span class="sr-only">Куда</span><input id="route-to" placeholder="Куда идём?" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="route-results" aria-expanded="false"/></label><button id="route-swap" aria-label="Поменять начало и конец">${icon("swap", 20)}</button></div>
<button id="route-use-location" class="route-current-origin" type="button" aria-label="Начать маршрут от моего местоположения на выбранном этаже">${icon("locate", 15)}От меня</button>
<div id="route-results" role="listbox" class="route-results" hidden></div>
<button id="route-build" class="primary-button">${icon("route", 18)}Построить маршрут</button>
<p id="route-status" class="route-status" role="status">Выберите две точки. Начало пути задаётся вручную.</p>
<div id="route-summary" hidden></div><div id="route-steps" hidden></div>
<div id="route-actions" class="route-actions" hidden><button id="route-fit">${icon("expand", 16)}Показать путь</button><button id="route-edit" aria-label="Изменить точки маршрута">Изменить</button><button id="route-share">${icon("share", 16)}Поделиться</button><button id="route-clear">Сбросить</button></div>
</section></div>
</aside>
<main class="map-shell">
  <div id="viewport"><div id="location-crosshair" class="location-crosshair" aria-hidden="true" hidden><span></span></div></div>
  <div class="map-top">
    <div class="breadcrumb" id="breadcrumb">Вернадского, 78 <span>/</span> Общий вид</div>
    <div class="mode-switch">
      <button id="nav-outside" class="active">Снаружи</button>
      <button id="nav-inside">Внутри</button>
      <button id="nav-stack" aria-label="Показать все этажи корпуса в 3D" hidden>Все этажи</button>
    </div>
    <div class="view-segment" role="group" aria-label="Проекция карты">
      <button id="mode-toggle" class="mode-toggle" type="button" aria-label="Переключить проекцию" aria-pressed="false">3D</button>
    </div>
  </div>
  <div class="focus-floor-status"><div id="focus-floor-status" aria-live="polite"></div><button id="building-rooms-open" type="button" aria-haspopup="dialog" aria-controls="building-rooms-dialog" hidden>Аудитории</button></div>
  <div class="map-title"><div class="eyebrow" id="view-eyebrow">ПРОСТРАНСТВО УНИВЕРСИТЕТА</div><h1 id="view-title">Весь кампус.<br><span>Каждый поворот.</span></h1><p id="view-description">Выберите корпус, чтобы заглянуть внутрь</p><div class="exterior-actions" id="exterior-actions"><button id="street-view">${icon("pin", 14)} Вид с улицы</button><button id="open-interior">${icon("layers", 14)} Открыть этаж</button><button id="aerial-view">${icon("cube", 14)} С высоты</button></div></div>
  <div id="floor-rail" class="floor-rail" role="group" aria-label="Переключение этажей"></div>
  <div class="map-tools"><button id="locate-open" title="Моё местоположение" aria-label="Моё местоположение">${icon("locate")}</button><button id="location-options" aria-label="Настройки местоположения и уточнение точки" title="Уточнить местоположение">${icon("settings", 17)}</button><button id="fit" title="Показать целиком" aria-label="Показать целиком">${icon("expand")}</button><div class="zoom-tools"><button id="zoom-in" aria-label="Приблизить">+</button><button id="zoom-out" aria-label="Отдалить">−</button></div></div>
  <div id="location-pick-banner" class="location-pick-banner" hidden><div><b id="location-pick-banner-text">Передвиньте карту под меткой</b><small id="location-pick-validity" role="status"></small></div><div class="location-pick-actions"><button id="location-pick-cancel">Отмена</button><button id="location-pick-confirm" class="primary-button" disabled>Я здесь</button></div></div>
  <div class="orientation"><span class="axis-arrow">↗</span><small>Оси плана</small></div>
  <div class="hover-tip" id="hover-tip" hidden></div>
  <div class="map-bottom"><div class="map-caption"><span class="caption-icon">${icon("layers", 23)}</span><div><b id="caption-title">Планы → пространство</b><small id="caption-subtitle">Загрузка…</small></div><span class="approx-badge" id="metric-badge">Высоты ≈</span></div><div class="legend"><span><i class="legend-room"></i>Помещения</span><span><i class="legend-stairs"></i>Лестницы</span><span><i class="legend-unknown"></i>Не уточнено</span></div></div>
  <div class="map-status"><span id="interaction-hint">Перетаскивание — вращение · ПКМ — перемещение · колесо — масштаб</span><span id="scale-note">Горизонтальная геометрия по плану</span></div>
  <div class="loading" id="loading"><span class="loader"></span><b>Собираем пространство</b><small id="load-message">Читаем планы кампуса</small></div>
  <div class="error-state" id="error" hidden></div>
</main>
<button id="clean-map-exit" type="button" hidden>Вернуть интерфейс</button>
<section id="route-guidance-dock" class="route-guidance-dock" hidden aria-label="Навигация по маршруту" aria-live="polite"></section>
<dialog id="building-rooms-dialog" aria-labelledby="building-rooms-title"><div class="dialog-heading"><h2 id="building-rooms-title">Аудитории</h2><button type="button" id="building-rooms-close" class="icon-button" aria-label="Закрыть список аудиторий">${icon("close")}</button></div><div class="building-rooms-content"><label id="building-rooms-filter">Этаж<select id="building-rooms-floor"></select></label><div id="building-rooms-list"></div></div></dialog>
<dialog id="location-dialog"><div class="dialog-heading"><h2>Местоположение</h2><button id="location-close" class="icon-button" aria-label="Закрыть местоположение">${icon("close")}</button></div><div class="location-content"><p id="location-current"></p><p id="location-tracking-state" role="status"></p><button id="location-gps" class="primary-button">Включить геопозицию</button><label id="location-follow-row" class="toggle-row" hidden><span>Следовать за мной</span><input id="location-follow" type="checkbox" checked/><span class="switch"></span></label><p id="location-heading-state"></p><button id="location-map" class="secondary-button">Уточнить точку на карте</button><p class="micro-note">Этаж переключается на карте. Геопозиция внутри здания приблизительная; если точка сместилась, уточните её заново.</p><button id="location-reset-correction" class="secondary-button" hidden>Сбросить поправку</button><p id="location-feedback" role="status"></p><details class="gps-refinement-records"><summary>Уточнения GPS<span id="gps-refinement-count"></span></summary><p id="gps-refinement-state" class="micro-note" role="status"></p><div class="gps-refinement-actions"><button id="gps-refinement-export" class="secondary-button" hidden>Выгрузить JSON</button><button id="gps-refinement-clear" class="location-clear" hidden>Удалить записи</button></div><p class="micro-note">Сохраняются только отмеченные вами места и соответствующие показания GPS. Это не запись всего пути; отправка файла — по вашей кнопке.</p></details><button id="location-clear" class="location-clear" hidden>Убрать точку</button></div></dialog>
<dialog id="settings-dialog"><div class="dialog-heading"><h2>Настройки</h2><button id="settings-close" class="icon-button" aria-label="Закрыть настройки">${icon("close")}</button></div><div class="settings-content"><label>Тема<select id="theme-setting"><option value="system">Как на устройстве</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label><label>Качество карты<select id="quality-setting"><option value="auto">Автоматически</option><option value="low">Экономия заряда</option><option value="high">Высокое</option></select></label><label class="toggle-row"><span>Меньше анимации</span><input id="motion-setting" type="checkbox"/><span class="switch"></span></label><div class="settings-layers"><h3>На карте</h3><button id="clean-map-enter" type="button" class="secondary-button">Чистая карта</button><label class="toggle-row"><span>Подписи мест</span><input type="checkbox" id="labels" checked/><span class="switch"></span></label><label class="toggle-row"><span>Фасады зданий</span><input type="checkbox" id="facades" checked/><span class="switch"></span></label><label class="toggle-row"><span>Улицы и здания рядом</span><input type="checkbox" id="context" checked/><span class="switch"></span></label><label class="toggle-row"><span>Соседние корпуса</span><input type="checkbox" id="neighbors"/><span class="switch"></span></label></div><div class="settings-note"><b>Офлайн-карта</b><p id="offline-status">В мобильное приложение включена карта Вернадского, 78. Поиск и маршруты используют встроенные данные. Веб-версия загружает их с сервера.</p></div><p class="micro-note">Контуры — по исходным планам. Высоты, фасады и расстояния приблизительны. Занятость аудиторий не отслеживается.</p></div></dialog>
<div id="toast" role="status" hidden></div>`;
