export type MessageType =
  | 'PLAY' | 'PAUSE' | 'RESUME' | 'STOP'
  | 'SKIP_NEXT' | 'SKIP_PREV'
  | 'GET_ARTICLE' | 'ARTICLE_CONTENT'
  | 'PLAY_AUDIO' | 'AUDIO_ENDED' | 'AUDIO_ERROR'
  | 'GET_STATUS' | 'STATUS_UPDATE'
  | 'SHOW_PLAYER' | 'HIDE_PLAYER'
  | 'STOP_AUDIO' | 'UPDATE_SETTINGS' | 'GET_VOICES';

export interface Message {
  type: MessageType;
  [key: string]: any;
}

export interface ArticleContent {
  title: string;
  byline?: string;
  sentences: string[];
  totalWords: number;
}

export interface PlaybackState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'done' | 'error';
  article: ArticleContent | null;
  currentIndex: number;
  voice: string;
  speed: number;
  errorMessage?: string;
  serverAvailable: boolean;
}
