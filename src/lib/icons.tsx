import {
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpandIcon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  ArrowShrinkIcon,
  ArrowTurnBackwardIcon,
  ArrowTurnForwardIcon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  AudioWave01Icon,
  BookOpen01Icon,
  Bookmark01Icon,
  BotIcon as Bot,
  BubbleChatNotificationIcon,
  Calendar03Icon,
  CalendarAdd01Icon,
  CalendarArrowDownIcon as CalendarArrowDown,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CheckmarkSquare01Icon,
  CircleIcon as Circle,
  Clock01Icon,
  CloudLittleRainIcon,
  Copy01Icon,
  CopyPlusIcon as CopyPlus,
  CornerDownLeftIcon,
  CornerUpRightIcon,
  Delete02Icon,
  Download01Icon,
  File01Icon,
  FileUploadIcon as FileUpload,
  FilterIcon as Filter,
  FocusIcon as Focus,
  GitForkIcon as GitFork,
  HighlighterIcon as Highlighter,
  Home01Icon,
  InformationCircleIcon,
  Key01Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  LinkSquare02Icon,
  ListIndentDecreaseIcon,
  ListIndentIncreaseIcon,
  Loading03Icon,
  LockKeyholeIcon,
  LockKeyholeOpenIcon,
  Logout01Icon,
  MaximizeIcon as Maximize,
  ModernTvIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  Move01Icon,
  PaletteIcon as Palette,
  PauseIcon as Pause,
  PencilEdit02Icon,
  PictureInPictureOnIcon,
  PinIcon as Pin,
  PlayIcon as Play,
  Plug01Icon,
  PlusSignIcon,
  PuzzleIcon as Puzzle,
  RefreshIcon as Refresh,
  Search01Icon,
  Settings01Icon,
  Shield01Icon,
  ShieldCheckIcon as ShieldCheck,
  SlidersHorizontalIcon,
  SmartPhone01Icon,
  SourceCodeSquareIcon,
  SparklesIcon as Sparkles,
  SquareSlashIcon as SquareSlash,
  StopWatchIcon,
  Sun03Icon,
  TerminalIcon as Terminal,
  TextAlignLeftIcon,
  TextBoldIcon,
  TextFontIcon,
  TextIcon as Text,
  TextItalicIcon,
  TextQuoteIcon as TextQuote,
  TextStrikethroughIcon,
  TextUnderlineIcon,
  Tick02Icon,
  TriangleAlertIcon as TriangleAlert,
  Unlink01Icon,
  UnavailableIcon,
  UserIcon as User,
  ViewOffSlashIcon,
  VolumeHighIcon,
  VolumeOffIcon as VolumeOff,
} from "@hugeicons/core-free-icons";
import {
  HugeiconsIcon,
  type HugeiconsProps,
  type IconSvgElement,
} from "@hugeicons/react";

// Commands and plugins take components, not icon data. Bind each glyph once so
// every surface uses the same free Stroke Rounded artwork and default weight.
// Brand marks and the live focus-progress pie are intentionally separate.
function createIcon(icon: IconSvgElement) {
  return function Icon(
    props: Omit<
      HugeiconsProps,
      "icon" | "altIcon" | "showAlt" | "strokeWidth" | "absoluteStrokeWidth"
    > & { "data-icon"?: "inline-start" | "inline-end" },
  ) {
    return (
      <HugeiconsIcon
        icon={icon}
        aria-hidden={
          props["aria-label"] || props["aria-labelledby"] ? undefined : true
        }
        {...props}
      />
    );
  };
}

export const AlignLeftIcon = createIcon(TextAlignLeftIcon);
export const ArrowDownIcon = createIcon(ArrowDown02Icon);
export const ArrowLeftIcon = createIcon(ArrowLeft02Icon);
export const ArrowUpIcon = createIcon(ArrowUp02Icon);
export const AudioWaveIcon = createIcon(AudioWave01Icon);
export const BanIcon = createIcon(UnavailableIcon);
export const BoldIcon = createIcon(TextBoldIcon);
export const BookOpenIcon = createIcon(BookOpen01Icon);
export const BookmarkIcon = createIcon(Bookmark01Icon);
export const BotIcon = createIcon(Bot);
export const CalendarIcon = createIcon(Calendar03Icon);
export const CalendarAddIcon = createIcon(CalendarAdd01Icon);
export const CalendarArrowDownIcon = createIcon(CalendarArrowDown);
export const CheckIcon = createIcon(Tick02Icon);
export const ChevronDownIcon = createIcon(ArrowDown01Icon);
export const ChevronLeftIcon = createIcon(ArrowLeft01Icon);
export const ChevronRightIcon = createIcon(ArrowRight01Icon);
export const ChevronUpIcon = createIcon(ArrowUp01Icon);
export const CircleIcon = createIcon(Circle);
export const CircleCheckIcon = createIcon(CheckmarkCircle01Icon);
export const ClockIcon = createIcon(Clock01Icon);
export const CloseIcon = createIcon(Cancel01Icon);
export const CollapseIcon = createIcon(ArrowShrinkIcon);
export const CopyIcon = createIcon(Copy01Icon);
export const CopyPlusIcon = createIcon(CopyPlus);
export const DownloadIcon = createIcon(Download01Icon);
export const EmbedIcon = createIcon(LinkSquare02Icon);
export const EnterIcon = createIcon(CornerDownLeftIcon);
export const ForwardIcon = createIcon(CornerUpRightIcon);
export const ErrorIcon = createIcon(CancelCircleIcon);
export const ExpandIcon = createIcon(ArrowExpandIcon);
export const ExternalLinkIcon = EmbedIcon;
export const FileIcon = createIcon(File01Icon);
export const FileUploadIcon = createIcon(FileUpload);
export const FilterIcon = createIcon(Filter);
export const FocusIcon = createIcon(Focus);
export const GitForkIcon = createIcon(GitFork);
export const HighlighterIcon = createIcon(Highlighter);
export const HomeIcon = createIcon(Home01Icon);
export const IndentIcon = createIcon(ListIndentIncreaseIcon);
export const InfoIcon = createIcon(InformationCircleIcon);
export const ItalicIcon = createIcon(TextItalicIcon);
export const KeyIcon = createIcon(Key01Icon);
export const LinkIcon = createIcon(Link01Icon);
export const ListIcon = createIcon(LeftToRightListBulletIcon);
export const LoaderIcon = createIcon(Loading03Icon);
export const LockIcon = createIcon(LockKeyholeIcon);
export const LogoutIcon = createIcon(Logout01Icon);
export const MaximizeIcon = createIcon(Maximize);
export const MessageWarningIcon = createIcon(BubbleChatNotificationIcon);
export const MonitorIcon = createIcon(ModernTvIcon);
export const MoonIcon = createIcon(Moon02Icon);
export const MoreIcon = createIcon(MoreHorizontalIcon);
export const MoveIcon = createIcon(Move01Icon);
export const NumberedIcon = createIcon(LeftToRightListNumberIcon);
export const OutdentIcon = createIcon(ListIndentDecreaseIcon);
export const PaletteIcon = createIcon(Palette);
export const PauseIcon = createIcon(Pause);
export const PencilIcon = createIcon(PencilEdit02Icon);
export const PictureInPictureIcon = createIcon(PictureInPictureOnIcon);
export const PinIcon = createIcon(Pin);
export const PlayIcon = createIcon(Play);
export const PlugIcon = createIcon(Plug01Icon);
export const PlusIcon = createIcon(PlusSignIcon);
export const PuzzleIcon = createIcon(Puzzle);
export const RainIcon = createIcon(CloudLittleRainIcon);
export const RedoIcon = createIcon(ArrowTurnForwardIcon);
export const RefreshIcon = createIcon(Refresh);
export const SearchIcon = createIcon(Search01Icon);
export const SettingsIcon = createIcon(Settings01Icon);
export const ShieldIcon = createIcon(Shield01Icon);
export const ShieldCheckIcon = createIcon(ShieldCheck);
export const SlidersIcon = createIcon(SlidersHorizontalIcon);
export const SmartphoneIcon = createIcon(SmartPhone01Icon);
export const SourceCodeIcon = createIcon(SourceCodeSquareIcon);
export const SparklesIcon = createIcon(Sparkles);
export const SpoilerIcon = createIcon(ViewOffSlashIcon);
export const SquareCheckIcon = createIcon(CheckmarkSquare01Icon);
export const SquareSlashIcon = createIcon(SquareSlash);
export const StopwatchIcon = createIcon(StopWatchIcon);
export const StrikethroughIcon = createIcon(TextStrikethroughIcon);
export const SunIcon = createIcon(Sun03Icon);
export const TerminalIcon = createIcon(Terminal);
export const TextIcon = createIcon(Text);
export const TextQuoteIcon = createIcon(TextQuote);
export const TextSizeIcon = createIcon(TextFontIcon);
export const TrashIcon = createIcon(Delete02Icon);
export const UnderlineIcon = createIcon(TextUnderlineIcon);
export const UndoIcon = createIcon(ArrowTurnBackwardIcon);
export const UnlinkIcon = createIcon(Unlink01Icon);
export const UnlockIcon = createIcon(LockKeyholeOpenIcon);
export const UserIcon = createIcon(User);
export const VolumeIcon = createIcon(VolumeHighIcon);
export const VolumeOffIcon = createIcon(VolumeOff);
export const WarningIcon = createIcon(TriangleAlert);
