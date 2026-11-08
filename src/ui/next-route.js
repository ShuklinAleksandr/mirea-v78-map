/** The drawn route ends at the parent entrance, not at the requested room. */
export function partialRouteInfo(route) {
  const leg = route?.lastLeg;
  if (
    !route?.partial ||
    leg?.kind !== "inside-parent" ||
    leg.geometryAvailable !== false
  )
    return null;
  const via = leg.viaLabel || route.end?.label;
  const destination = route.requestedDestination?.label || leg.label;
  if (!via || !destination) return null;
  return {
    via,
    destination,
    summary: `Маршрут до входа в ${via}; дальше — ${destination} внутри.`,
    instruction: leg.message,
    note: `Путь внутри ${via} пока не нанесён.`,
    completion: `Маршрут до ${via} завершён. Дальше найдите ${destination} внутри.`,
  };
}

/** Compact navigation uses the same tracker evidence as the classic view.
 * This presentation never changes floors or supplies a synthetic position. */
export function nextRouteReadout({
  route,
  to,
  guiding,
  automatic,
  previewing,
  stepIndex = 0,
  liveProgress,
  userLocation,
  following = false,
  transitionLevel,
}) {
  const step = route?.steps?.[stepIndex];
  const partial = partialRouteInfo(route);
  const finalStep = stepIndex === (route?.steps?.length || 0) - 1;
  const manualEntry = Boolean(
    partial && (step?.kind === "manual-entry" || liveProgress?.arrived),
  );
  const manualOnly = manualEntry && route.steps.length === 1;
  const transition = Boolean(step?.targetFloorId);
  const status = automatic ? liveProgress?.status || "waiting" : "manual";
  const tracking = guiding && automatic && status === "tracking";
  const notes = {
    waiting: "Нет геопозиции · пока можно идти по шагам",
    acquiring: "Уточняем положение…",
    tracking: "Шаги меняются автоматически",
    "low-accuracy": "Положение неточное · автосмена шагов на паузе",
    stale: "Нет свежей геопозиции · автосмена шагов на паузе",
    "off-route": "Точка вне подтверждённого пути",
    "floor-mismatch": "Проверьте этаж · GPS его не определяет",
    "floor-change": "Подтвердите переход по лестнице",
    arrived: "Проверьте номер помещения на месте",
    manual: "Переключайте шаги, когда дойдёте до указанного места",
  };
  let contextAction = null;
  if (guiding && automatic && !previewing && !manualOnly) {
    if (["low-accuracy", "off-route"].includes(status))
      contextAction = "refine";
    else if (status === "floor-mismatch") {
      // Changing the viewed floor cannot repair a previously confirmed
      // position. Let the user place it again on the correct floor instead.
      const confirmedLocationMismatch =
        liveProgress?.reason === "confirm-route-physical-floor" ||
        (userLocation?.floorEvidence === "manual" &&
          userLocation.floorId &&
          liveProgress?.floorId &&
          userLocation.floorId !== liveProgress.floorId);
      contextAction = confirmedLocationMismatch ? "refine" : "floor";
    } else if (status === "stale") contextAction = "locate";
  }
  const text = String(step?.text || "");
  const direction = manualEntry
    ? "manual-entry"
    : step?.kind === "stairs"
      ? "stairs"
      : finalStep
        ? "arrive"
        : /налево/iu.test(text)
          ? "left"
          : /направо/iu.test(text)
            ? "right"
            : "straight";
  const distance =
    guiding &&
    tracking &&
    !manualOnly &&
    Number.isFinite(liveProgress?.distanceToNextMeters)
      ? `≈ ${Math.max(0, Math.round(liveProgress.distanceToNextMeters))} м${manualEntry ? ` до ${partial.via}` : ""}`
      : "";
  return {
    status,
    direction,
    distance,
    meta: guiding
      ? `${partial ? `До ${partial.via}` : to?.label || "Назначение"} · шаг ${stepIndex + 1} из ${route.steps.length}`
      : `${route?.durationMinutes != null ? `≈ ${route.durationMinutes} мин · ` : ""}${route?.distanceMeters != null ? `≈ ${Math.round(route.distanceMeters)} м` : "Маршрут готов"}${partial ? ` · до ${partial.via}` : ""}`,
    note: guiding
      ? previewing
        ? `${partial ? `Демонстрация до ${partial.via}` : "Демонстрация"} · это не ваше движение`
        : manualEntry
          ? liveProgress?.arrived && automatic
            ? `По GPS — у входа в ${partial.via}. ${partial.note}`
            : partial.note
          : notes[status] || notes.waiting
      : partial?.note || "Путь по карте · расстояние и время приблизительные",
    nextLabel: !guiding
      ? "В путь"
      : finalStep
        ? partial
          ? "Закрыть маршрут"
          : "Завершить"
        : transition
          ? Number.isFinite(transitionLevel)
            ? transitionLevel === -1
              ? "Я в цоколе"
              : `Я на ${transitionLevel} этаже`
            : "Я на следующем этаже"
          : "Следующий шаг",
    showNext: !guiding || !tracking || finalStep || transition,
    contextAction,
    contextLabel: {
      refine: "Уточнить точку",
      floor: "Выбрать этаж",
      locate: "Обновить геопозицию",
    }[contextAction],
    showRecenter: Boolean(
      guiding && !following && !contextAction && !manualOnly,
    ),
  };
}
