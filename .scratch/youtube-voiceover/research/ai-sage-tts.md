# Проверка моделей озвучки ai-sage

Дата проверки: 2026-09-10.

## Вывод

В проверенном публичном каталоге ai-sage на Hugging Face моделей TTS не обнаружено. Для первой версии применяется выбранный пользователем запасной вариант — Silero. Это вывод о доступных публикациях на дату проверки, а не утверждение об отсутствии внутренних или будущих моделей ai-sage.

## Проверка

Просмотрены [страница организации](https://huggingface.co/ai-sage), обе страницы [каталога моделей](https://huggingface.co/ai-sage/models) ([продолжение](https://huggingface.co/ai-sage/models?p=1)) и [AudioModels](https://huggingface.co/collections/ai-sage/audiomodels). Разновременный кэш веб-страниц сверён прямым запросом публичных метаданных через установленный HF CLI:

```sh
HF_HUB_DISABLE_IMPLICIT_TOKEN=1 hf models ls --author ai-sage --limit 100 --format json
```

[API каталога](https://huggingface.co/api/models?author=ai-sage&limit=100) вернул 38 моделей: 25 text-generation, 3 sentence-similarity, 2 feature-extraction, 2 automatic-speech-recognition и 6 без pipeline_tag. Названия и теги всех записей просмотрены; последние шесть — варианты текстового GigaChat. Моделей с TTS/text-to-speech/text-to-audio не найдено. Проверка не ограничивалась тегами: прочитаны карточки трёх аудиомоделей из официальной коллекции.

| Модель | Что документировано | Почему не подходит для озвучки |
| --- | --- | --- |
| [GigaAM-v3](https://huggingface.co/ai-sage/GigaAM-v3) | ASR и SSL-энкодер; пример transcribe возвращает текст | Распознаёт речь, не синтезирует её |
| [GigaAM-Multilingual](https://huggingface.co/ai-sage/GigaAM-Multilingual) | Многоязычное ASR и SSL; CTC-варианты; transcribe | Это преобразование аудио в текст |
| [GigaChat3.1-Audio-10B-A1.8B](https://huggingface.co/ai-sage/GigaChat3.1-Audio-10B-A1.8B) | Понимание аудио, ASR, перевод, ответы на вопросы и временная локализация; пример декодирует текстовые токены | Наличие audio/speech-translation в тегах не означает синтез: генерация звука и каталог голосов не документированы |

## Ограничения и последствие для проекта

Веса не скачивались, модели не запускались, качество Silero этим исследованием не оценивалось. Частные репозитории и сервисы вне указанной организации не исследовались. Выбор Silero следует из явного условия пользователя, а не из сравнительного бенчмарка. Точный checkpoint и прослушивание голосов остаются проверкой реализации/приёмки.

## Исследовательский контекст

Ветка: `research/youtube-voiceover-ai-sage`. Изолированный worktree: `/tmp/daevox-youtube-voiceover-ai-sage`. Отчёт скопирован в основную рабочую директорию для карты wayfinder.
