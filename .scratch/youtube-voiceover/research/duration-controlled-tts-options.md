# TTS с управлением длительностью для русского дубляжа

Дата проверки: 2026-09-11. Исследование первичных источников; новые модели и облачные API в этой работе не запускались, видео никуда не отправлялось. Локальная работоспособность Qwen 1.7B известна из предыдущих проб проекта; качество других вариантов на данном ролике неизвестно.

## Что считать решением

Нужно различать время вычисления модели, длительность WAV и положение произнесённых смысловых фрагментов относительно видео. Быстрый inference, streaming и низкий RTF уменьшают ожидание результата, но не сокращают озвучку. `speed=1.2`, инструкция «говори быстрее» и `target_duration=4s` — разные контракты. Даже синтез ровно четырёх секунд не гарантирует, что все слова в них разборчиво произнесены.

Приоритет для проекта: сначала исправлять временной бюджет перевода и сборки; затем сравнивать TTS по качеству при одинаковом бюджете. Замена тембра сама по себе не обеспечивает синхронизацию. Ниже восемь направлений: от минимального изменения текущего Qwen до специализированных систем.

## Сводная таблица

| Вариант | Управление | Русский и английские термины | Главный предел | Роль в проекте |
|---|---|---|---|---|
| Qwen3-TTS 1.7B | Текстовая инструкция о темпе, стиле, паузах | RU/EN поддерживаются; текущая проба выявила проблемы отдельных терминов | Нет опубликованного числового target duration в официальном wrapper | Первый дешёвый эксперимент: быстрая нейтральная подача + русский reference |
| F5-TTS Russian (hotstone228) | Явная длина mel + speed | Автор fine-tune заявляет RU и EN; смешанное предложение надо проверять | Слишком тесный бюджет может повредить речь; NC-SA веса | Самый интересный локальный эксперимент с заданной длиной |
| XTTS-v2 | Числовой speed, интерполяция латентов | RU и EN заявлены; code-switch не гарантирован | Не duration-conditioned; артефакты при сильном ускорении; CPML | Второстепенный baseline |
| Azure Neural / MultilingualNeural | `mstts:audioduration`, prosody, lang | Есть русские голоса и multilingual RU+EN | 0.5–2× исходной длины, не любой текст в любое окно | Наиболее прямой облачный TTS baseline |
| Google Chirp 3 HD | `speaking_rate`, SSML / pause controls | RU заявлен; произношения можно задавать | Числового target duration в AudioConfig нет; часть controls Preview | Облачный baseline качества при заданном темпе |
| Amazon Polly Standard | `amazon:max-duration` | RU Maxim/Tatyana; English terms требуют отдельной проверки | Только Standard; до 5×, затем превышение окна | Контрольный duration baseline, не ожидаемый лидер тембра |
| ElevenLabs Dubbing | Дубляж с сохранением timing; Fixed clips в v1 Studio | Russian включён в список Dubbing | v2 Alpha; собственные переводы и правки v2 API — Enterprise | Сравнить с готовой системой, а не обычным TTS |
| Meta Seamless | Speech-to-speech; Expressive переносит rate и pauses | Expressive НЕ имеет русского выходного vocoder | Не путать языки M4T и Expressive | Архитектурный ориентир, Expressive исключить для EN→RU |

Таблица — краткая интерпретация источников ниже, не сравнительный тест звучания.

## 1. Сохранить Qwen и изменить способ задания речи

Официальный `generate_custom_voice` принимает text, speaker, language, instruct и generation kwargs. Числовые duration/rate не объявлены. Настройки генерации включают sampling, repetition penalty и `max_new_tokens`; ограничение токенов обрывает генерацию, а не обучает её уложить все слова в окно. У 0.6B wrapper очищает инструкцию; у 1.7B она используется. [Исходный wrapper](https://raw.githubusercontent.com/QwenLM/Qwen3-TTS/main/qwen_tts/inference/qwen3_tts_model.py).

Семейство поддерживает русский, English и свободные инструкции; есть Base для reference cloning и VoiceDesign. Лицензия репозитория Apache-2.0. Эти возможности не являются обещанием точной длины. [Официальный репозиторий](https://github.com/QwenLM/Qwen3-TTS).

**Предлагаемый эксперимент:** на 12 плотных/обычных фразах сравнить нынешнюю инструкцию с «быстрая ровная речь технического диктора, без драматических пауз, слитно, но разборчиво». Отдельно Base с коротким реальным русскоязычным reference в желаемом темпе. Reference — мягкое условие, не жёсткий метроном. Для каждого варианта фиксировать длительность, паузы, точность терминов, ASR-пропуски и оценку на слух; использовать одинаковые тексты и несколько seeds. Не обещать, что prompt «4 секунды» будет исполнен. На текущей RTX 5080 Qwen уже работал; новое измерение VRAM не выполнено.

## 2. F5-TTS с русским fine-tune: реальное условие длины

Оригинальный F5-TTS не следует автоматически считать русским. Но upstream перечисляет сторонний Russian fine-tune HotDro4illa, а **сама карточка hotstone228/F5-TTS-Russian прямо заявляет дообучение для RU и EN**. Карточка указывает CC-BY-NC-SA-4.0; старый upstream список пишет CC-BY-NC-4.0 — для выбора артефакта надо ориентироваться на его актуальные файлы/карточку, а не переносить MIT-лицензию кода на веса. Качество переключения языков и технических терминов здесь не доказано. [Карточка автора](https://huggingface.co/hotstone228/F5-TTS-Russian), [upstream список](https://raw.githubusercontent.com/SWivid/F5-TTS/main/src/f5_tts/infer/SHARED.md).

В upstream `fix_duration` означает **сумму reference и нового аудио**. Для нового фрагмента T секунд нужен `fix_duration ≈ ref_seconds + T`. Значение переводится в кадры при 24 kHz / hop 256, затем reference удаляется. `speed` без fixed duration меняет расчёт длины из отношения UTF-8 байтов reference/target; это ненадёжный естественный estimator для межъязыкового текста. Текущий main распределяет fixed duration между chunks с учётом crossfade — версию надо закрепить, а не предполагать такое поведение в любом релизе. [Реализация inference](https://raw.githubusercontent.com/SWivid/F5-TTS/main/src/f5_tts/infer/utils_infer.py).

Нижняя граница `sample()` зависит от числа текстовых токенов и reference; запрошенная слишком малая длина увеличивается. Точная длина также квантуется кадрами. Даже допустимая длина не доказывает разборчивость: нужно проверять пропуски, повторы и слишком плотное произношение. [Реализация CFM](https://raw.githubusercontent.com/SWivid/F5-TTS/main/src/f5_tts/model/cfm.py).

**Предлагаемая реализация:** независимый adapter `synthesize(text, reference, target_seconds)` с возвратом actual_seconds и quality flags. Тестировать 100%, 90%, 80%, 70% естественной длины на том же корпусе, а затем сопоставить с тем же сжатием Qwen через DSP. Иначе нельзя понять преимущество duration-conditioned синтеза. Upstream предоставляет CUDA inference; RTX 5080 представляется реалистичной для коротких фрагментов, но совместимость torch/Blackwell и пиковая VRAM данного fine-tune не измерены. Не грузить всю дорожку единым diffusion sequence. [Установка и runtime upstream](https://github.com/SWivid/F5-TTS).

## 3. XTTS-v2: числовой темп без жёсткой длины

Русский входит в официальный список. API имеет `speed`; документация предупреждает об артефактах далеко от 1.0. Код реализует `length_scale = 1/speed` и интерполяцию GPT latents перед vocoder. Это скорее сжатие внутреннего представления, чем генерация с обученным дедлайном. Code-switch RU+EN в одном вызове отдельной гарантией не заявлен. [Документация](https://github.com/coqui-ai/TTS/blob/dev/docs/source/models/xtts.md), [код](https://github.com/coqui-ai/TTS/blob/dev/TTS/tts/models/xtts.py).

Веса XTTS-v2 используют Coqui Public Model License, которая явно ограничивает модель и outputs некоммерческим использованием; это не та же лицензия, что у Python-кода. [Лицензия артефакта](https://huggingface.co/coqui/XTTS-v2/raw/main/LICENSE.txt).

Для исследования можно сравнить 1.0/1.15/1.3 и качество русского reference, но миграция только ради параметра speed выглядит слабее устранения пауз/временного планирования Qwen. CUDA путь есть; работа на конкретной RTX 5080 и актуальных зависимостях не проверена.

## 4. Azure: наиболее прямой облачный контракт длительности

`mstts:audioduration value="4s"` относится ко всему enclosing voice. Допускает длину 0.5–2 от исходной без других rate settings, максимум 300 секунд; вне допустимого отношения результат ограничивается границей, а не обещанными секундами. Multilingual voices поддерживают `<lang>` на уровне слов, включая ru-RU и en-US. Например Andrew/Ava/Brian/Emma MultilingualNeural. Для немультиязычных голосов `lang` не поддерживается. [SSML voice, language и audioduration](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice).

Также есть нативные `ru-RU-DmitryNeural`, Svetlana и Dariya; multilingual-способности нельзя автоматически приписывать им. [Список голосов](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support).

**Предлагаемая реализация:** один запрос на временное окно, нейтральный MultilingualNeural, language spans для терминов, целевой duration; на выходе проверка WAV и слов. Если длительность не помещается либо речь неудобна, переформулировать перевод. Не включать одновременно произвольные rate/duration регуляторы без измерения. Не переносить поддержку всех тегов на все новые HD/LLM голоса. Облачный проприетарный сервис, локальной GPU не требует; реальные вызовы и цена в исследовании не проверялись.

## 5. Google Cloud: современный контроль pace, но не секунд

Свежая страница Chirp 3 HD перечисляет русский. Она уже описывает pace 0.25–2.0, SSML для synchronous requests и pronunciation controls; SSML/voice controls помечены Preview. Поэтому распространённое старое утверждение «Chirp не умеет rate/SSML» сейчас слишком широкое. Markup `[pause]` не задаёт точную длину и может игнорироваться. `<lang>` отсутствует в перечисленных supported SSML elements; поддержку word-level RU/EN switching нельзя выводить из списка языков. [Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd).

AudioConfig задаёт speakingRate, но не target duration. Нужно сначала измерить естественную длину, затем изменить rate и проверить output. [API AudioConfig](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/AudioConfig).

**Предлагаемый эксперимент:** один русский голос на плотном наборе, 1.0/1.15/1.3; термины через pronunciation или speech_text. Сравнить с Qwen по сохранению согласных/цифр и естественности при одинаковой конечной длине. Проприетарный облачный сервис; встроить через общий adapter, а не переписывать pipeline под него.

## 6. Amazon Polly: верхняя граница, ограниченная старым движком

`prosody amazon:max-duration` доступен **только Standard**, ускоряет до 5×, но не замедляет короткую речь и не добавляет padding. Если даже 5× недостаточно, результат всё равно длиннее цели. До 1500 символов внутри тега; паузы входят в бюджет; rate внутри max-duration игнорируется. [Официальные ограничения](https://docs.aws.amazon.com/polly/latest/dg/maxduration-tag.html).

Русские Tatyana и Maxim в таблице имеют только Standard, без Neural/Generative. [Голоса](https://docs.aws.amazon.com/polly/latest/dg/available-voices.html).

Это пригодный контрольный пример «длительность управляется, но слушать может быть неудобно». Для финального качественного дубляжа приоритет низкий; 5× — техническая граница сервиса, не рекомендуемый темп. Произношение English внутри русского необходимо испытывать. Облачный сервис, локальные ресурсы не нужны.

## 7. ElevenLabs: готовый дубляж и фиксированные окна

Dubbing v2 Alpha заявляет сохранение timing вместе с голосом и эмоцией. Это end-to-end workflow, не просто замена TTS; перенос эмоции может конфликтовать с запросом на нейтральную подачу. Русский присутствует в официальном списке языков Dubbing. Ни один из этих фактов не является гарантией точного lip-sync или сохранности каждого технического термина. [Dubbing overview](https://elevenlabs.io/docs/overview/capabilities/dubbing), [языки](https://elevenlabs.io/docs/help-center/product/dubbing/which-languages-are-supported-in-dubbing).

Полезная конкретная практика: v1 Dubbing Studio по умолчанию использует **Fixed Generations** — длина клипа сохраняется, темп меняется. Dynamic Generations меняет длину под текст и может нарушить sync. Studio находится в maintenance mode, новых функций не планируется. [Fixed/Dynamic и состояние Studio](https://elevenlabs.io/docs/eleven-creative/products/dubbing/dubbing-studio).

Актуальный v2 API: создать project, добавить language target, получить output асинхронно. Передача своих переводов — Enterprise only, требуется покрыть каждый source segment ровно один раз; генерация language target оплачивается. Не путать этот API с legacy `/v1/dubbing`. [Create language target](https://elevenlabs.io/docs/api-reference/dubbing/language-targets/create-language-target), [quickstart](https://elevenlabs.io/docs/eleven-api/guides/cookbooks/dubbing).

**Предлагаемый эксперимент:** заказать только небольшой известный отрезок как внешний baseline синхронизации; сравнить смысл, timing и термины с нашим пайплайном. Если собственного перевода нет в доступном тарифе, эксперимент проверит всю систему целиком и не позволит отделить качество перевода от TTS. В рамках этого исследования файлы не отправлялись и платные операции не выполнялись.

## 8. Seamless speech-to-speech: полезная архитектура, важное исключение

SeamlessExpressive переносит phrase-level prosody, rate и pauses; API имеет duration_factor. Но выходной PRETSSEL vocoder перечисляет только cmn/deu/eng/fra/ita/spa — русского нет. Нельзя брать широкую поддержку русского в SeamlessM4T и объявлять тем самым поддержку Expressive. [Model card и factor](https://huggingface.co/facebook/seamless-expressive), [точный список vocoder](https://raw.githubusercontent.com/facebookresearch/seamless_communication/main/src/seamless_communication/cards/vocoder_pretssel.yaml).

M4T остаётся отдельным speech translation baseline, но не даёт автоматически свойств expressivity/timing другого checkpoint. Expressive требует gated access и принятия собственной лицензии. Не расходовать время на локальную установку Expressive для EN→RU; взять из работы идею совместного моделирования перевода и временной структуры. [Различия моделей](https://github.com/facebookresearch/seamless_communication).

## Практический порядок реализации

1. **Сначала текущий Qwen:** откалибровать быструю нейтральную инструкцию и русский reference; устранить накопление лишних пауз; переводить по измеримому временному бюджету. Это эксперимент, не гарантия достаточного сокращения.
2. **Параллельные технические baseline в следующем эксперименте:** F5 Russian с явной длиной и Azure audioduration. Первый проверяет локальный duration-conditioned подход, второй — зрелый облачный контракт. Обоим давать одинаковые короткие фразы, цели и glossary.
3. **Внешний end-to-end baseline:** ElevenLabs Dubbing на фрагменте; учитывать отличие перевода и тарифа. Google — запасной TTS baseline, XTTS/Polly — более низкий приоритет.
4. Единый результат adapter: `audio`, `requested_duration`, `actual_duration`, `control_mode` (instruct/rate/duration), `quality_flags`. Дедлайн и смысл должны проверяться независимо от модели.
5. Приёмка: не число WAV и не только совпадение длины. Нужны точность терминов/чисел/отрицаний, разборчивость на слух, задержка относительно смысловых/визуальных событий, отсутствие обрезаний, фактический темп, доля повторных синтезов, время и ресурс генерации. Для короткого успешного набора затем повторить полный ролик.

Ни один найденный вариант не отменяет компромисса: при слишком длинном переводе нужно сделать его компактнее, говорить быстрее, использовать доступные паузы или изменять видеоряд. Модель с заданной длительностью перемещает этот компромисс внутрь генератора; она не гарантирует автоматическое сохранение всех слов.
