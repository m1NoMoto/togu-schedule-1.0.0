import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.togudv.schedule.student',
  appName: 'ТОГУ.Расписание',
  webDir: 'dist',
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_togu_schedule',
      iconColor: '#2563EB',
    },
  },
};

export default config;
